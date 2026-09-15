// =============================================================================
//  core/ProviderRouter.js — OmniRouter: one key, many providers
//
//  A unified, OpenAI-compatible routing layer. External tools point at a single
//  master key; this module fans the request out across every configured
//  upstream provider. It fuses three ideas:
//
//    • OpenRouter-like — OpenAI-shaped surface, "provider/model" slugs, a
//      `models: []` fallback array in the request body, usage + cost ledger.
//    • OmniRoute-like  — failover chains with a per-provider/key circuit
//      breaker and exponential-backoff health tracking.
//    • 9router-like    — per-provider KEY POOL with rotation strategies
//      (priority | round-robin | least-used | weighted).
//
//  Every outbound HTTP call goes through an injectable transport so the whole
//  router is testable without a socket:
//
//    transport(request) -> Promise<{ status, headers, data?, raw?, stream? }>
//      request = { url, method, headers, body, stream, timeoutMs, providerId, model }
//      - reject with an Error for network-level failures (trips the breaker)
//      - when request.stream is true and the upstream returned 2xx, resolve
//        with `stream` (a Readable of raw SSE bytes) instead of `data`
//
//  Slug rules (see ProviderRegistry.resolveModel):
//    "anthropic/claude-sonnet-4"            → pinned to the anthropic provider
//    "openrouter/anthropic/claude-sonnet-4" → pinned to openrouter
//    "gpt-4o"                               → unpinned, routed by strategy
// =============================================================================
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const STRATEGIES = ['priority', 'round-robin', 'least-used', 'weighted'];

const BREAKER_BASE_MS = 5000;        // first cooldown after a failure
const BREAKER_MAX_MS = 300000;       // cap at 5 minutes
const MODEL_CACHE_TTL_MS = 300000;   // listModels() cache — 5 minutes
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

// USD per 1M tokens. Unknown models fall back to zero — the ledger still counts
// tokens, it just reports 0 cost rather than guessing.
const PRICE_TABLE = {
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'o3': { input: 2, output: 8 },
    'o3-mini': { input: 1.1, output: 4.4 },
    'o4-mini': { input: 1.1, output: 4.4 },
    'claude-3-opus': { input: 15, output: 75 },
    'claude-3-5-sonnet': { input: 3, output: 15 },
    'claude-3-5-haiku': { input: 0.8, output: 4 },
    'claude-sonnet-4': { input: 3, output: 15 },
    'claude-opus-4': { input: 15, output: 75 },
    'claude-haiku-4': { input: 1, output: 5 },
    'deepseek-chat': { input: 0.27, output: 1.1 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
    'llama-3.1-8b': { input: 0.05, output: 0.08 },
    'llama-3.3-70b': { input: 0.59, output: 0.79 },
    'gemini-1.5-pro': { input: 1.25, output: 5 },
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-2.5-pro': { input: 1.25, output: 10 },
    'moonshot-v1-8k': { input: 0.2, output: 0.2 },
    'kimi-k2': { input: 0.6, output: 2.5 },
    'grok-2': { input: 2, output: 10 },
    'grok-3': { input: 3, output: 15 },
    'grok-4': { input: 3, output: 15 },
};

function emptyBucket() {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

function isRec(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function newWireId(prefix) {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function flattenText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const part of content) {
            if (typeof part === 'string') parts.push(part);
            else if (isRec(part) && typeof part.text === 'string') parts.push(part.text);
            else if (isRec(part) && typeof part.thinking === 'string') parts.push(part.thinking);
            else if (isRec(part) && part.type === 'tool_result') parts.push(flattenText(part.content));
        }
        return parts.filter(Boolean).join('\n');
    }
    if (isRec(content) && typeof content.text === 'string') return content.text;
    return '';
}

function openaiContentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (isRec(part) && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('');
}

function imageUrlFromAnthropicBlock(block) {
    if (!isRec(block) || block.type !== 'image') return null;
    const source = block.source;
    if (!isRec(source)) return null;
    if (source.type === 'base64' && typeof source.data === 'string') {
        const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
        return `data:${media};base64,${source.data}`;
    }
    if (source.type === 'url' && typeof source.url === 'string') return source.url;
    return null;
}

function finishToStopReason(finish, hasToolUse) {
    if (finish === 'length') return 'max_tokens';
    if (finish === 'tool_calls') return 'tool_use';
    if (finish === 'content_filter') return 'refusal';
    if (hasToolUse) return 'tool_use';
    return 'end_turn';
}

function anthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return undefined;
    const out = [];
    for (const tool of tools) {
        if (!isRec(tool)) continue;
        if (tool.type === 'function' && isRec(tool.function)) {
            out.push(tool);
            continue;
        }
        const name = tool.name || (tool.function && tool.function.name);
        if (!name) continue;
        out.push({
            type: 'function',
            function: {
                name,
                description: tool.description || '',
                parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
            },
        });
    }
    return out.length ? out : undefined;
}

function anthropicToolChoiceToOpenAI(choice) {
    if (choice == null) return undefined;
    if (choice === 'auto' || choice === 'none') return choice;
    if (choice === 'any' || choice === 'required') return 'required';
    if (isRec(choice) && (choice.type === 'tool' || choice.type === 'function')) {
        const name = choice.name || (choice.function && choice.function.name);
        if (name) return { type: 'function', function: { name } };
    }
    return undefined;
}

function responsesToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return undefined;
    const out = [];
    for (const tool of tools) {
        if (!isRec(tool)) continue;
        if (tool.type === 'function' && isRec(tool.function)) {
            out.push(tool);
            continue;
        }
        if (tool.type === 'function' || typeof tool.name === 'string') {
            out.push({
                type: 'function',
                function: {
                    name: tool.name || '',
                    description: tool.description || '',
                    parameters: tool.parameters || { type: 'object', properties: {} },
                },
            });
        }
    }
    return out.length ? out : undefined;
}

/** Anthropic Messages request → OpenAI chat.completions body. */
function anthropicMessagesToChat(body = {}) {
    const messages = [];
    const systemText = flattenText(body.system);
    if (systemText) messages.push({ role: 'system', content: systemText });

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    for (const msg of incoming) {
        if (!isRec(msg)) continue;
        const role = msg.role === 'assistant' ? 'assistant'
            : msg.role === 'system' ? 'system'
            : 'user';
        const content = msg.content;

        if (typeof content === 'string') {
            messages.push({ role, content });
            continue;
        }
        if (!Array.isArray(content)) {
            const text = flattenText(content);
            if (text || role === 'assistant') messages.push({ role, content: text });
            continue;
        }

        if (role === 'assistant') {
            const texts = [];
            const toolCalls = [];
            for (const block of content) {
                if (!isRec(block)) continue;
                if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
                else if (block.type === 'thinking' && typeof block.thinking === 'string') texts.push(block.thinking);
                else if (block.type === 'tool_use') {
                    let args = '{}';
                    try { args = JSON.stringify(block.input ?? {}); } catch (e) { args = '{}'; }
                    toolCalls.push({
                        id: typeof block.id === 'string' && block.id ? block.id : `call_${crypto.randomBytes(8).toString('hex')}`,
                        type: 'function',
                        function: { name: block.name || '', arguments: args },
                    });
                }
            }
            const openaiMsg = { role: 'assistant', content: texts.join('\n') || (toolCalls.length ? null : '') };
            if (toolCalls.length) openaiMsg.tool_calls = toolCalls;
            messages.push(openaiMsg);
            continue;
        }

        const parts = [];
        const flushParts = () => {
            if (!parts.length) return;
            if (parts.length === 1 && parts[0].type === 'text') {
                messages.push({ role, content: parts[0].text });
            } else {
                messages.push({ role, content: parts.slice() });
            }
            parts.length = 0;
        };
        for (const block of content) {
            if (!isRec(block)) continue;
            if (block.type === 'tool_result') {
                flushParts();
                messages.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id || '',
                    content: typeof block.content === 'string' ? block.content : flattenText(block.content),
                });
                continue;
            }
            if (block.type === 'text' && typeof block.text === 'string') {
                parts.push({ type: 'text', text: block.text });
                continue;
            }
            const imageUrl = imageUrlFromAnthropicBlock(block);
            if (imageUrl) parts.push({ type: 'image_url', image_url: { url: imageUrl } });
        }
        flushParts();
    }

    const chat = { model: body.model, messages };
    if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
    if (body.temperature != null) chat.temperature = body.temperature;
    if (body.top_p != null) chat.top_p = body.top_p;
    if (body.stop_sequences != null) chat.stop = body.stop_sequences;
    const tools = anthropicToolsToOpenAI(body.tools);
    if (tools) chat.tools = tools;
    const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
    if (toolChoice) chat.tool_choice = toolChoice;
    if (Array.isArray(body.models)) chat.models = body.models;
    return chat;
}

/** OpenAI chat.completion → Anthropic Messages response. */
function chatToAnthropicMessage(data, fallbackModel) {
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const message = (choice && choice.message) || {};
    const content = [];
    const text = openaiContentToText(message.content);
    if (text) content.push({ type: 'text', text });
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (!isRec(call)) continue;
            const fn = isRec(call.function) ? call.function : {};
            let input = {};
            if (typeof fn.arguments === 'string' && fn.arguments) {
                try { input = JSON.parse(fn.arguments); } catch (e) { input = {}; }
            } else if (isRec(fn.arguments)) {
                input = fn.arguments;
            }
            content.push({
                type: 'tool_use',
                id: call.id || newWireId('toolu'),
                name: fn.name || call.name || '',
                input,
            });
        }
    }
    if (!content.length) content.push({ type: 'text', text: '' });

    const usage = (data && data.usage) || {};
    const hasToolUse = content.some(block => block.type === 'tool_use');
    return {
        id: (data && data.id) || newWireId('msg'),
        type: 'message',
        role: 'assistant',
        content,
        model: (data && data.model) || fallbackModel || '',
        stop_reason: finishToStopReason(choice && choice.finish_reason, hasToolUse),
        stop_sequence: null,
        usage: {
            input_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
            output_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
        },
    };
}

function responsesInputToMessages(input, messages) {
    if (typeof input === 'string') {
        if (input) messages.push({ role: 'user', content: input });
        return;
    }
    if (!Array.isArray(input)) return;
    for (const item of input) {
        if (typeof item === 'string') {
            if (item) messages.push({ role: 'user', content: item });
            continue;
        }
        if (!isRec(item)) continue;
        const type = item.type;

        if (type === 'function_call') {
            let args = item.arguments;
            if (typeof args !== 'string') {
                try { args = JSON.stringify(args ?? {}); } catch (e) { args = '{}'; }
            }
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id || item.id || newWireId('call'),
                    type: 'function',
                    function: { name: item.name || '', arguments: args || '{}' },
                }],
            });
            continue;
        }
        if (type === 'function_call_output' || type === 'tool_result') {
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id || item.tool_use_id || '',
                content: typeof item.output === 'string' ? item.output
                    : typeof item.content === 'string' ? item.content
                    : flattenText(item.output || item.content),
            });
            continue;
        }
        if (type === 'input_text' && typeof item.text === 'string') {
            messages.push({ role: 'user', content: item.text });
            continue;
        }

        if (type === 'message' || item.role) {
            const role = item.role === 'assistant' ? 'assistant'
                : item.role === 'system' || item.role === 'developer' ? 'system'
                : item.role === 'tool' ? 'tool'
                : 'user';
            const content = item.content;
            if (typeof content === 'string') {
                const msg = { role, content };
                if (role === 'tool') msg.tool_call_id = item.call_id || item.tool_call_id || '';
                messages.push(msg);
                continue;
            }
            if (!Array.isArray(content)) {
                const text = flattenText(content);
                if (text) messages.push({ role, content: text });
                continue;
            }
            const parts = [];
            for (const part of content) {
                if (typeof part === 'string') {
                    parts.push({ type: 'text', text: part });
                    continue;
                }
                if (!isRec(part)) continue;
                if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
                    parts.push({ type: 'text', text: part.text });
                    continue;
                }
                if (part.type === 'input_image' || part.type === 'image_url') {
                    const url = typeof part.image_url === 'string' ? part.image_url
                        : (isRec(part.image_url) && typeof part.image_url.url === 'string') ? part.image_url.url
                        : null;
                    if (url) parts.push({ type: 'image_url', image_url: { url } });
                }
            }
            if (!parts.length) continue;
            if (parts.length === 1 && parts[0].type === 'text') messages.push({ role, content: parts[0].text });
            else messages.push({ role, content: parts });
        }
    }
}

/** OpenAI Responses request → OpenAI chat.completions body. */
function responsesToChat(body = {}) {
    const messages = [];
    const instructions = flattenText(body.instructions);
    if (instructions) messages.push({ role: 'system', content: instructions });
    responsesInputToMessages(body.input, messages);

    const chat = { model: body.model, messages };
    if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
    else if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
    if (body.temperature != null) chat.temperature = body.temperature;
    if (body.top_p != null) chat.top_p = body.top_p;
    const tools = responsesToolsToOpenAI(body.tools);
    if (tools) chat.tools = tools;
    if (body.tool_choice != null) chat.tool_choice = body.tool_choice;
    if (Array.isArray(body.models)) chat.models = body.models;
    return chat;
}

/** OpenAI chat.completion → OpenAI Responses object. */
function chatToResponses(data, fallbackModel) {
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const message = (choice && choice.message) || {};
    const output = [];
    const text = openaiContentToText(message.content);
    if (text) {
        output.push({
            id: newWireId('msg'),
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
        });
    }
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (!isRec(call)) continue;
            const fn = isRec(call.function) ? call.function : {};
            output.push({
                type: 'function_call',
                id: call.id || newWireId('fc'),
                call_id: call.id || newWireId('call'),
                name: fn.name || '',
                arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
                status: 'completed',
            });
        }
    }
    if (!output.length) {
        output.push({
            id: newWireId('msg'),
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }],
        });
    }

    const usage = (data && data.usage) || {};
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    const rawId = data && data.id ? String(data.id) : '';
    const id = rawId ? rawId.replace(/^chatcmpl[-_]?/, 'resp_') : newWireId('resp');
    return {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: (choice && choice.finish_reason === 'length') ? 'incomplete' : 'completed',
        error: null,
        model: (data && data.model) || fallbackModel || '',
        output,
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: Number(usage.total_tokens ?? 0) || (inputTokens + outputTokens),
        },
    };
}

function sseFramesForAnthropic(message) {
    const frames = [];
    frames.push({ event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null } } });
    (message.content || []).forEach((block, index) => {
        if (block.type === 'text') {
            frames.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
            frames.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text || '' } } });
        } else if (block.type === 'tool_use') {
            frames.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } });
            frames.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } } });
        } else {
            frames.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } });
        }
        frames.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    });
    frames.push({
        event: 'message_delta',
        data: {
            type: 'message_delta',
            delta: { stop_reason: message.stop_reason, stop_sequence: null },
            usage: { output_tokens: (message.usage && message.usage.output_tokens) || 0 },
        },
    });
    frames.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return frames;
}

function sseFramesForResponses(payload) {
    const frames = [];
    frames.push({ event: 'response.created', data: { type: 'response.created', response: { ...payload, status: 'in_progress', output: [] } } });
    for (const item of payload.output || []) {
        if (item.type !== 'message') continue;
        for (const part of item.content || []) {
            if (part.type === 'output_text' && part.text) {
                frames.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: part.text } });
            }
        }
    }
    frames.push({ event: 'response.completed', data: { type: 'response.completed', response: payload } });
    return frames;
}

function writeSseEvent(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function finishReasonToAnthropic(reason) {
    if (reason === 'length') return 'max_tokens';
    if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
    return 'end_turn';
}

/**
 * Parse an OpenAI chat.completion SSE Readable and fire token callbacks.
 * Used to translate `/v1/messages` and `/v1/responses` streams token-by-token
 * instead of buffering the whole reply.
 *
 * @param {import('stream').Readable} stream
 * @param {{ onStart?: Function, onText?: Function, onDone?: Function }} hooks
 */
function pipeOpenAiSse(stream, hooks = {}) {
    return new Promise((resolve, reject) => {
        if (!stream || typeof stream.on !== 'function') {
            const err = new Error('upstream stream is not readable');
            if (typeof hooks.onDone === 'function') {
                try { hooks.onDone({ finish: null, error: err }); } catch (e) { /* ignore */ }
            }
            return reject(err);
        }

        let buf = '';
        let started = false;
        let finish = null;
        let settled = false;

        const finishOnce = (error) => {
            if (settled) return;
            settled = true;
            if (typeof hooks.onDone === 'function') {
                try { hooks.onDone({ finish, error: error || null }); } catch (e) { /* ignore */ }
            }
            if (error) reject(error);
            else resolve({ finish });
        };

        const consumeBlock = (raw) => {
            const data = raw.split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('');
            if (!data) return;
            if (data === '[DONE]') {
                finishOnce(null);
                if (typeof stream.destroy === 'function') {
                    try { stream.destroy(); } catch (e) { /* ignore */ }
                }
                return;
            }
            let json;
            try { json = JSON.parse(data); } catch (e) { return; }
            if (!started) {
                started = true;
                if (typeof hooks.onStart === 'function') hooks.onStart(json);
            }
            const choice = Array.isArray(json.choices) ? json.choices[0] : null;
            const delta = (choice && choice.delta) || {};
            if (typeof delta.content === 'string' && delta.content) {
                if (typeof hooks.onText === 'function') hooks.onText(delta.content, json);
            }
            if (choice && choice.finish_reason) finish = choice.finish_reason;
        };

        stream.on('data', (chunk) => {
            if (settled) return;
            buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            buf = buf.replace(/\r\n/g, '\n');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                try { consumeBlock(raw); } catch (err) { finishOnce(err); return; }
                if (settled) return;
            }
        });
        stream.on('end', () => {
            if (buf.trim() && !settled) {
                try { consumeBlock(buf); } catch (err) { return finishOnce(err); }
            }
            finishOnce(null);
        });
        stream.on('error', (err) => finishOnce(err));
    });
}

function pipeOpenAiSseToAnthropic(stream, res, { model, id } = {}) {
    let opened = false;
    return pipeOpenAiSse(stream, {
        onStart(json) {
            opened = true;
            writeSseEvent(res, 'message_start', {
                type: 'message_start',
                message: {
                    id: (json && json.id) ? String(json.id).replace(/^chatcmpl[-_]?/, 'msg_') : (id || newWireId('msg')),
                    type: 'message',
                    role: 'assistant',
                    model: (json && json.model) || model || '',
                    content: [],
                    stop_reason: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });
            writeSseEvent(res, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            });
        },
        onText(text) {
            if (!opened) return;
            writeSseEvent(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
            });
        },
        onDone({ finish }) {
            if (!opened) {
                writeSseEvent(res, 'message_start', {
                    type: 'message_start',
                    message: {
                        id: id || newWireId('msg'),
                        type: 'message',
                        role: 'assistant',
                        model: model || '',
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                });
                writeSseEvent(res, 'content_block_start', {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                });
            }
            writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            writeSseEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: finishReasonToAnthropic(finish), stop_sequence: null },
                usage: { output_tokens: 0 },
            });
            writeSseEvent(res, 'message_stop', { type: 'message_stop' });
        },
    });
}

function pipeOpenAiSseToResponses(stream, res, { model, id } = {}) {
    const responseId = id || newWireId('resp');
    let opened = false;
    let text = '';
    return pipeOpenAiSse(stream, {
        onStart(json) {
            opened = true;
            writeSseEvent(res, 'response.created', {
                type: 'response.created',
                response: {
                    id: (json && json.id) ? String(json.id).replace(/^chatcmpl[-_]?/, 'resp_') : responseId,
                    object: 'response',
                    status: 'in_progress',
                    model: (json && json.model) || model || '',
                    output: [],
                },
            });
        },
        onText(delta) {
            if (!opened) return;
            text += delta;
            writeSseEvent(res, 'response.output_text.delta', {
                type: 'response.output_text.delta',
                delta,
            });
        },
        onDone({ finish }) {
            const rid = responseId;
            if (!opened) {
                writeSseEvent(res, 'response.created', {
                    type: 'response.created',
                    response: { id: rid, object: 'response', status: 'in_progress', model: model || '', output: [] },
                });
            }
            const completed = {
                id: rid,
                object: 'response',
                status: finish === 'length' ? 'incomplete' : 'completed',
                model: model || '',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text }],
                }],
            };
            writeSseEvent(res, 'response.completed', { type: 'response.completed', response: completed });
        },
    });
}

/** Bearer first, then x-api-key — Claude Code talks to the gateway with Bearer. */
function presentedMasterKey(req) {
    const auth = String((req && req.headers && req.headers.authorization) || '');
    if (auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        if (token) return token;
    }
    const header = req && req.headers && req.headers['x-api-key'];
    const xKey = Array.isArray(header) ? header[0] : header;
    return typeof xKey === 'string' ? xKey.trim() : '';
}

class ProviderRouter {
    /**
     * @param {object}   opts
     * @param {object}   opts.registry   ProviderRegistry instance (required)
     * @param {string}   [opts.masterKey] defaults to process.env.OMNIROUTER_KEY, else generated
     * @param {string}   [opts.strategy]  'priority' | 'round-robin' | 'least-used' | 'weighted'
     * @param {Function} [opts.transport] injectable HTTP transport (see banner)
     * @param {Function} [opts.now]       clock injection, defaults to Date.now
     * @param {string}   [opts.appUrl]    OpenRouter HTTP-Referer
     * @param {string}   [opts.appTitle]  OpenRouter X-Title
     * @param {number}   [opts.timeoutMs]
     */
    constructor(opts = {}) {
        const { registry, masterKey, strategy, transport, now, appUrl, appTitle, timeoutMs } = opts;
        if (!registry) throw new Error('[ProviderRouter] a ProviderRegistry instance is required');

        this.registry = registry;
        this.strategy = STRATEGIES.includes(strategy) ? strategy : 'priority';
        this.transport = typeof transport === 'function' ? transport : this._defaultTransport.bind(this);
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.appUrl = appUrl || process.env.OMNIROUTER_APP_URL || 'https://localhost';
        this.appTitle = appTitle || process.env.OMNIROUTER_APP_TITLE || 'OmniRouter';
        this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

        this.masterKey = masterKey || process.env.OMNIROUTER_KEY || ProviderRouter.generateMasterKey();
        this.generatedMasterKey = !masterKey && !process.env.OMNIROUTER_KEY;

        this.breakers = new Map();    // "providerId::key" → { failures, openUntil, lastError }
        this.keyUsage = new Map();    // "providerId::key" → count
        this.keyCursor = new Map();   // providerId → rotation cursor
        this.providerCursor = 0;      // global provider rotation cursor
        this.providerUsage = new Map(); // providerId → count

        this.usage = { totals: emptyBucket(), byProvider: {}, byModel: {}, startedAt: new Date().toISOString() };
        this.modelCache = { at: 0, data: null };
    }

    static generateMasterKey() {
        return 'omni-' + crypto.randomBytes(24).toString('hex');
    }

    // -------------------------------------------------------------------------
    //  Master key gate
    // -------------------------------------------------------------------------

    getMasterKey() {
        return this.masterKey;
    }

    /** Constant-time compare. Length mismatch short-circuits (timingSafeEqual throws on it). */
    verifyMasterKey(presented) {
        try {
            if (typeof presented !== 'string' || !presented) return false;
            const a = Buffer.from(presented, 'utf8');
            const b = Buffer.from(this.masterKey, 'utf8');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch (err) {
            console.warn('[ProviderRouter] Master key verification failed:', err.message);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    //  Circuit breaker + health
    // -------------------------------------------------------------------------

    _breakerKey(providerId, key) {
        return `${providerId}::${key || '-'}`;
    }

    /** @returns {boolean} true when this provider/key pair is not cooling down */
    _isHealthy(providerId, key) {
        const state = this.breakers.get(this._breakerKey(providerId, key));
        if (!state) return true;
        return this.now() >= state.openUntil;
    }

    /** Trip the breaker with exponential backoff: 5s, 10s, 20s … capped at 5min. */
    _tripBreaker(providerId, key, error) {
        const id = this._breakerKey(providerId, key);
        const state = this.breakers.get(id) || { failures: 0, openUntil: 0, lastError: null };
        state.failures += 1;
        const cooldown = Math.min(BREAKER_BASE_MS * Math.pow(2, state.failures - 1), BREAKER_MAX_MS);
        state.openUntil = this.now() + cooldown;
        state.lastError = error ? String(error.message || error) : null;
        state.cooldownMs = cooldown;
        this.breakers.set(id, state);
        return state;
    }

    _resetBreaker(providerId, key) {
        this.breakers.delete(this._breakerKey(providerId, key));
    }

    /** A provider is routable only if it is enabled and has at least one healthy key. */
    _providerHealthy(provider) {
        if (!provider || !provider.enabled) return false;
        if (provider.keyless || provider.keys.length === 0) return this._isHealthy(provider.id, null);
        return provider.keys.some(key => this._isHealthy(provider.id, key));
    }

    getHealth() {
        const out = {};
        for (const [id, state] of this.breakers.entries()) {
            const [providerId] = id.split('::');
            out[providerId] = out[providerId] || { openKeys: 0, failures: 0, nextRetryAt: 0 };
            out[providerId].failures += state.failures;
            if (this.now() < state.openUntil) {
                out[providerId].openKeys += 1;
                out[providerId].nextRetryAt = Math.max(out[providerId].nextRetryAt, state.openUntil);
            }
        }
        return out;
    }

    // -------------------------------------------------------------------------
    //  Key pool rotation (9router style)
    // -------------------------------------------------------------------------

    /**
     * Pick the next key from a provider's pool, honouring the active strategy.
     * @returns {string|null|undefined} a key, `null` for keyless providers,
     *          or `undefined` when every key is cooling down (skip this provider).
     */
    _nextKey(provider, strategy = this.strategy) {
        if (!provider) return undefined;
        if (provider.keyless && provider.keys.length === 0) {
            return this._isHealthy(provider.id, null) ? null : undefined;
        }
        const pool = provider.keys.filter(key => this._isHealthy(provider.id, key));
        if (pool.length === 0) return undefined;

        let chosen;
        if (strategy === 'round-robin') {
            const cursor = this.keyCursor.get(provider.id) || 0;
            chosen = pool[cursor % pool.length];
            this.keyCursor.set(provider.id, cursor + 1);
        } else if (strategy === 'least-used' || strategy === 'weighted') {
            // 'weighted' biases provider ORDER (below); within a pool every key is
            // equal, so fall through to least-used for a deterministic spread.
            chosen = pool.reduce((best, key) => {
                const a = this.keyUsage.get(this._breakerKey(provider.id, key)) || 0;
                const b = this.keyUsage.get(this._breakerKey(provider.id, best)) || 0;
                return a < b ? key : best;
            }, pool[0]);
        } else {
            chosen = pool[0];
        }

        const usageId = this._breakerKey(provider.id, chosen);
        this.keyUsage.set(usageId, (this.keyUsage.get(usageId) || 0) + 1);
        return chosen;
    }

    getKeyUsage() {
        const out = {};
        for (const [id, count] of this.keyUsage.entries()) out[id] = count;
        return out;
    }

    // -------------------------------------------------------------------------
    //  Candidate chain building
    // -------------------------------------------------------------------------

    _providerHasModel(provider, model) {
        if (!provider.models.length) return false;
        return provider.models.some(entry => entry === model
            || entry === `${provider.id}/${model}`
            || entry.endsWith(`/${model}`));
    }

    /** Which model string this provider should actually be asked for. */
    _modelForProvider(provider, rawModel, resolved) {
        if (this._providerHasModel(provider, rawModel)) return rawModel;
        if (resolved && provider.id === resolved.providerId) return resolved.model;
        if (resolved && this._providerHasModel(provider, resolved.model)) return resolved.model;
        return rawModel;
    }

    _orderProviders(providers, strategy = this.strategy) {
        const list = [...providers];
        if (strategy === 'round-robin') {
            list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
            if (list.length > 1) {
                const offset = this.providerCursor % list.length;
                this.providerCursor += 1;
                return list.slice(offset).concat(list.slice(0, offset));
            }
            return list;
        }
        if (strategy === 'least-used') {
            return list.sort((a, b) =>
                (this.providerUsage.get(a.id) || 0) - (this.providerUsage.get(b.id) || 0)
                || a.priority - b.priority || a.id.localeCompare(b.id));
        }
        if (strategy === 'weighted') {
            // Least-loaded relative to weight — deterministic, no RNG.
            const load = p => (this.providerUsage.get(p.id) || 0) / Math.max(p.weight, 1);
            return list.sort((a, b) => load(a) - load(b) || a.priority - b.priority || a.id.localeCompare(b.id));
        }
        return list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    }

    /**
     * Build the ordered failover chain for a request.
     * @returns {{providerId:string, model:string, source:string}[]}
     */
    buildCandidates(body = {}, strategy = this.strategy) {
        const candidates = [];
        const seen = new Set();
        const push = (providerId, model, source) => {
            if (!providerId || !model) return;
            const id = `${providerId}|${model}`;
            if (seen.has(id)) return;
            seen.add(id);
            candidates.push({ providerId, model, source });
        };

        const requested = [];
        if (body.model) requested.push(String(body.model));
        if (Array.isArray(body.models)) {
            for (const entry of body.models) {
                const value = typeof entry === 'string' ? entry : entry && entry.model;
                if (value) requested.push(String(value));
            }
        }
        if (!requested.length) return candidates;

        // 1 + 2. Explicit provider pins, primary model first then body.models[].
        for (let i = 0; i < requested.length; i++) {
            const resolved = this.registry.resolveModel(requested[i]);
            if (!resolved) continue;
            const provider = this.registry.get(resolved.providerId);
            if (!provider || !provider.enabled) continue;
            push(provider.id, resolved.model, i === 0 ? 'slug' : 'fallback-slug');
        }

        // 3. Everything else that is enabled, ordered by strategy. Providers that
        //    advertise the model win over those with an unknown catalogue.
        const enabled = this.registry.getAll().filter(p => p.enabled);
        const ordered = this._orderProviders(enabled, strategy);
        for (let i = 0; i < requested.length; i++) {
            const raw = requested[i];
            const resolved = this.registry.resolveModel(raw);
            const known = ordered.filter(p => this._providerHasModel(p, raw)
                || (resolved && this._providerHasModel(p, resolved.model)));
            const pool = known.length ? known : ordered;
            for (const provider of pool) {
                push(provider.id, this._modelForProvider(provider, raw, resolved), i === 0 ? 'strategy' : 'fallback');
            }
        }

        return candidates;
    }

    // -------------------------------------------------------------------------
    //  Auth translation
    // -------------------------------------------------------------------------

    /** Per-provider header shaping — Anthropic and OpenRouter differ from the norm. */
    _buildHeaders(provider, key, extra = {}) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(provider.headers || {}),
        };
        if (key) {
            if (provider.auth === 'x-api-key' || provider.id === 'anthropic') {
                headers['x-api-key'] = key;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                headers.Authorization = `Bearer ${key}`;
            }
        }
        if (provider.id === 'openrouter') {
            headers['HTTP-Referer'] = this.appUrl;
            headers['X-Title'] = this.appTitle;
        }
        return { ...headers, ...extra };
    }

    // -------------------------------------------------------------------------
    //  Usage / cost ledger
    // -------------------------------------------------------------------------

    _priceFor(model) {
        const raw = String(model || '').toLowerCase();
        const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
        if (PRICE_TABLE[bare]) return PRICE_TABLE[bare];
        let best = null;
        for (const [name, price] of Object.entries(PRICE_TABLE)) {
            if (bare.startsWith(name) && (!best || name.length > best.name.length)) best = { name, price };
        }
        return best ? best.price : { input: 0, output: 0 };
    }

    /**
     * Accumulate an OpenAI-shaped usage object into the ledger.
     * @returns {object} the delta that was applied
     */
    _recordUsage(providerId, model, usage = {}) {
        const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0) || 0;
        const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0) || 0;
        const total = Number(usage.total_tokens ?? usage.totalTokens ?? 0) || prompt + completion;
        const price = this._priceFor(model);
        const costUsd = (prompt / 1e6) * price.input + (completion / 1e6) * price.output;

        const delta = { requests: 1, promptTokens: prompt, completionTokens: completion, totalTokens: total, costUsd };
        const apply = bucket => {
            bucket.requests += delta.requests;
            bucket.promptTokens += delta.promptTokens;
            bucket.completionTokens += delta.completionTokens;
            bucket.totalTokens += delta.totalTokens;
            bucket.costUsd += delta.costUsd;
        };
        apply(this.usage.totals);
        this.usage.byProvider[providerId] = this.usage.byProvider[providerId] || emptyBucket();
        apply(this.usage.byProvider[providerId]);
        const modelId = `${providerId}/${model}`;
        this.usage.byModel[modelId] = this.usage.byModel[modelId] || emptyBucket();
        apply(this.usage.byModel[modelId]);

        this.providerUsage.set(providerId, (this.providerUsage.get(providerId) || 0) + 1);
        return delta;
    }

    getUsageReport() {
        const round = bucket => ({ ...bucket, costUsd: Math.round(bucket.costUsd * 1e6) / 1e6 });
        return {
            startedAt: this.usage.startedAt,
            generatedAt: new Date().toISOString(),
            totals: round(this.usage.totals),
            byProvider: Object.fromEntries(Object.entries(this.usage.byProvider).map(([k, v]) => [k, round(v)])),
            byModel: Object.fromEntries(Object.entries(this.usage.byModel).map(([k, v]) => [k, round(v)])),
            health: this.getHealth(),
        };
    }

    resetUsage() {
        this.usage = { totals: emptyBucket(), byProvider: {}, byModel: {}, startedAt: new Date().toISOString() };
        return this.getUsageReport();
    }

    // -------------------------------------------------------------------------
    //  Core routing
    // -------------------------------------------------------------------------

    /**
     * Route an OpenAI-shaped chat completion across the failover chain.
     *
     * @param {object} body  { model, messages, stream, models?: [] , ... }
     * @param {object} [opts] { transport, strategy, timeoutMs, headers, signal }
     * @returns {Promise<{ok, data, stream?, providerId, model, attempts, usage}>}
     * @throws  aggregate Error (`.attempts`) when every candidate fails.
     *
     * Streaming: when `body.stream === true` the upstream Readable is handed
     * back untouched on `.stream` so SSE frames pass through byte-for-byte.
     * Token usage cannot be tallied without parsing the stream, so streamed
     * calls are counted as a request with zero tokens.
     */
    async chatCompletion(body = {}, opts = {}) {
        if (!body || typeof body !== 'object') throw new Error('[ProviderRouter] chatCompletion requires an object body');
        const strategy = STRATEGIES.includes(opts.strategy) ? opts.strategy : this.strategy;
        const transport = typeof opts.transport === 'function' ? opts.transport : this.transport;
        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs;
        const streaming = body.stream === true;

        const candidates = this.buildCandidates(body, strategy);
        const attempts = [];
        if (!candidates.length) {
            const err = new Error(`[ProviderRouter] No enabled provider can serve model "${body.model}"`);
            err.name = 'ProviderRouterError';
            err.attempts = attempts;
            err.status = 503;
            throw err;
        }

        for (const candidate of candidates) {
            const provider = this.registry.get(candidate.providerId);
            if (!this._providerHealthy(provider)) {
                attempts.push({ providerId: candidate.providerId, model: candidate.model, ok: false, skipped: true, reason: 'cooling-down' });
                continue;
            }
            const key = this._nextKey(provider, strategy);
            if (key === undefined) {
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, skipped: true, reason: 'no-healthy-key' });
                continue;
            }

            const upstream = { ...body, model: candidate.model };
            delete upstream.models;   // fallback list is ours, never forwarded

            const started = this.now();
            try {
                const response = await transport({
                    url: `${provider.baseUrl}/chat/completions`,
                    method: 'POST',
                    headers: this._buildHeaders(provider, key, opts.headers),
                    body: upstream,
                    stream: streaming,
                    timeoutMs,
                    signal: opts.signal,
                    providerId: provider.id,
                    model: candidate.model,
                });

                const status = Number(response && response.status) || 0;
                if (status >= 200 && status < 300) {
                    this._resetBreaker(provider.id, key);
                    const data = response.data ?? null;
                    const usage = streaming ? null : (data && data.usage) || {};
                    const delta = this._recordUsage(provider.id, candidate.model, usage || {});
                    attempts.push({ providerId: provider.id, model: candidate.model, ok: true, status, ms: this.now() - started });
                    return {
                        ok: true,
                        data,
                        stream: response.stream || null,
                        headers: response.headers || {},
                        providerId: provider.id,
                        model: candidate.model,
                        source: candidate.source,
                        attempts,
                        usage: delta,
                    };
                }

                // Retryable upstream failure → trip the breaker and move on.
                const message = this._errorMessage(response);
                const retryable = status === 429 || status >= 500 || status === 401 || status === 403;
                if (retryable) this._tripBreaker(provider.id, key, new Error(message));
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, status, error: message, ms: this.now() - started });
            } catch (err) {
                // Network-level failure — always trips the breaker.
                this._tripBreaker(provider.id, key, err);
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, status: 0, error: String(err.message || err), ms: this.now() - started });
            }
        }

        const summary = attempts
            .map(a => `${a.providerId}/${a.model} → ${a.skipped ? a.reason : `${a.status || 'ERR'} ${a.error || ''}`.trim()}`)
            .join('; ');
        const err = new Error(`[ProviderRouter] All ${attempts.length} candidate(s) failed for "${body.model}": ${summary}`);
        err.name = 'ProviderRouterError';
        err.attempts = attempts;
        err.status = attempts.find(a => a.status)?.status || 502;
        throw err;
    }

    _errorMessage(response) {
        try {
            const data = response && response.data;
            if (data && data.error) return String(data.error.message || data.error);
            if (data && data.message) return String(data.message);
            if (response && response.raw) return String(response.raw).slice(0, 500);
        } catch (e) {}
        return `HTTP ${response && response.status}`;
    }

    // -------------------------------------------------------------------------
    //  Model catalogue
    // -------------------------------------------------------------------------

    /**
     * Aggregated catalogue across enabled providers. Never throws — a provider
     * that cannot be listed is skipped with a warning. Cached for 5 minutes.
     * @returns {Promise<{id:string, provider:string, model:string}[]>}
     */
    async listModels(opts = {}) {
        if (!opts.force && this.modelCache.data && this.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
            return this.modelCache.data;
        }
        const transport = typeof opts.transport === 'function' ? opts.transport : this.transport;
        const out = [];
        const seen = new Set();
        const add = (provider, model, extra = {}) => {
            const name = String(model || '').trim();
            if (!name) return;
            const id = `${provider.id}/${name}`;
            if (seen.has(id)) return;
            seen.add(id);
            out.push({ id, provider: provider.id, model: name, object: 'model', owned_by: provider.id, ...extra });
        };

        for (const provider of this.registry.getAll()) {
            if (!provider.enabled) continue;
            if (provider.models.length) {
                for (const model of provider.models) add(provider, model);
                continue;
            }
            if (!this._providerHealthy(provider)) continue;
            const key = this._nextKey(provider);
            if (key === undefined) continue;
            try {
                const response = await transport({
                    url: `${provider.baseUrl}/models`,
                    method: 'GET',
                    headers: this._buildHeaders(provider, key),
                    body: null,
                    stream: false,
                    timeoutMs: opts.timeoutMs || 15000,
                    providerId: provider.id,
                });
                const status = Number(response && response.status) || 0;
                if (status < 200 || status >= 300) throw new Error(this._errorMessage(response));
                const list = response.data?.data || response.data?.models || [];
                if (!Array.isArray(list)) throw new Error('unexpected /models payload');
                for (const item of list) {
                    const name = typeof item === 'string' ? item : item && (item.id || item.name);
                    add(provider, name, typeof item === 'object' && item ? { created: item.created } : {});
                }
            } catch (err) {
                console.warn(`[ProviderRouter] Could not list models for ${provider.id}:`, err.message);
            }
        }

        this.modelCache = { at: this.now(), data: out };
        return out;
    }

    // -------------------------------------------------------------------------
    //  Default transport (Node builtins only)
    // -------------------------------------------------------------------------

    _defaultTransport(request) {
        return new Promise((resolve, reject) => {
            let url;
            try {
                url = new URL(request.url);
            } catch (err) {
                return reject(new Error(`[ProviderRouter] Invalid upstream URL: ${request.url}`));
            }
            const agent = url.protocol === 'http:' ? http : https;
            const payload = request.body ? Buffer.from(JSON.stringify(request.body), 'utf8') : null;
            const headers = { ...request.headers };
            if (payload) headers['Content-Length'] = payload.length;
            if (request.stream) headers.Accept = 'text/event-stream';

            const req = agent.request({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || undefined,
                path: url.pathname + url.search,
                method: request.method || 'POST',
                headers,
            }, res => {
                const status = res.statusCode || 0;
                if (request.stream && status >= 200 && status < 300) {
                    // Hand the raw SSE stream straight back — no re-framing.
                    return resolve({ status, headers: res.headers, stream: res, data: null });
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
                    resolve({ status, headers: res.headers, data, raw });
                });
                res.on('error', reject);
            });

            req.setTimeout(request.timeoutMs || this.timeoutMs, () => {
                req.destroy(new Error(`upstream timeout after ${request.timeoutMs || this.timeoutMs}ms`));
            });
            req.on('error', reject);
            if (request.signal) {
                if (request.signal.aborted) req.destroy(new Error('aborted'));
                else request.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
            }
            if (payload) req.write(payload);
            req.end();
        });
    }

    // -------------------------------------------------------------------------
    //  OpenAI-compatible HTTP surface (mountable, never creates a server)
    // -------------------------------------------------------------------------

    /**
     * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean}
     *          true when the request was handled (caller should stop), false otherwise.
     *
     *   POST /v1/chat/completions   OpenAI Chat Completions (passthrough; SSE if stream)
     *   POST /v1/messages           Anthropic Messages (translated via chatCompletion)
     *   POST /v1/responses           OpenAI Responses (translated via chatCompletion)
     *   GET  /v1/models
     *   GET  /v1/usage
     *
     * Auth: `Authorization: Bearer <masterKey>` or `x-api-key: <masterKey>`.
     * Translated routes request an upstream OpenAI SSE when the client sets
     * `stream: true`, then re-emit Anthropic / Responses events token-by-token.
     * If the upstream does not return a stream, they fall back to a one-shot
     * SSE of the completed payload.
     */
    createHttpHandler() {
        const routes = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/usage']);

        const send = (res, status, payload, extraHeaders = {}) => {
            try {
                if (res.headersSent) return;
                const bodyText = JSON.stringify(payload);
                res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText), ...extraHeaders });
                res.end(bodyText);
            } catch (err) {
                console.warn('[ProviderRouter] Failed to write response:', err.message);
            }
        };
        const fail = (res, status, message, code, extra = {}) =>
            send(res, status, { error: { message, type: code === 'invalid_api_key' ? 'invalid_request_error' : 'api_error', code, ...extra } });

        const readBody = req => new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_REQUEST_BYTES) {
                    req.destroy();
                    return reject(new Error('request body too large'));
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });

        return (req, res) => {
            let pathname;
            try {
                pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
            } catch (err) {
                return false;
            }
            if (!routes.has(pathname)) return false;

            if (!this.verifyMasterKey(presentedMasterKey(req))) {
                fail(res, 401, 'Invalid OmniRouter master key.', 'invalid_api_key');
                return true;
            }

            const method = String(req.method || 'GET').toUpperCase();

            if (pathname === '/v1/models') {
                if (method !== 'GET') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
                this.listModels()
                    .then(data => send(res, 200, { object: 'list', data }))
                    .catch(err => fail(res, 500, String(err.message || err), 'model_list_failed'));
                return true;
            }

            if (pathname === '/v1/usage') {
                if (method !== 'GET') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
                try {
                    send(res, 200, this.getUsageReport());
                } catch (err) {
                    fail(res, 500, String(err.message || err), 'usage_failed');
                }
                return true;
            }

            // POST /v1/chat/completions | /v1/messages | /v1/responses
            if (method !== 'POST') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
            readBody(req)
                .then(async raw => {
                    let body;
                    try {
                        body = JSON.parse(raw || '{}');
                    } catch (err) {
                        return fail(res, 400, 'Request body is not valid JSON.', 'invalid_json');
                    }
                    const metaOf = result => ({ 'x-omnirouter-provider': result.providerId, 'x-omnirouter-model': result.model });
                    const writeSse = (frames, extraHeaders = {}) => {
                        try {
                            if (res.headersSent) return;
                            res.writeHead(200, {
                                'Content-Type': 'text/event-stream',
                                'Cache-Control': 'no-cache',
                                Connection: 'keep-alive',
                                ...extraHeaders,
                            });
                            for (const frame of frames) {
                                if (frame.event) res.write(`event: ${frame.event}\n`);
                                res.write(`data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`);
                            }
                            res.end();
                        } catch (err) {
                            console.warn('[ProviderRouter] Failed to write SSE:', err.message);
                        }
                    };

                    if (pathname === '/v1/messages') {
                        const wantStream = body.stream === true;
                        const result = await this.chatCompletion({
                            ...anthropicMessagesToChat(body),
                            stream: wantStream,
                        });
                        if (wantStream && result.stream) {
                            if (!res.headersSent) {
                                res.writeHead(200, {
                                    'Content-Type': 'text/event-stream',
                                    'Cache-Control': 'no-cache',
                                    Connection: 'keep-alive',
                                    ...metaOf(result),
                                });
                            }
                            await pipeOpenAiSseToAnthropic(result.stream, res, { model: result.model });
                            try { res.end(); } catch (e) { /* ignore */ }
                            return;
                        }
                        const payload = chatToAnthropicMessage(result.data, result.model);
                        if (wantStream) return writeSse(sseFramesForAnthropic(payload), metaOf(result));
                        return send(res, 200, payload, metaOf(result));
                    }
                    if (pathname === '/v1/responses') {
                        const wantStream = body.stream === true;
                        const result = await this.chatCompletion({
                            ...responsesToChat(body),
                            stream: wantStream,
                        });
                        if (wantStream && result.stream) {
                            if (!res.headersSent) {
                                res.writeHead(200, {
                                    'Content-Type': 'text/event-stream',
                                    'Cache-Control': 'no-cache',
                                    Connection: 'keep-alive',
                                    ...metaOf(result),
                                });
                            }
                            await pipeOpenAiSseToResponses(result.stream, res, { model: result.model });
                            try { res.end(); } catch (e) { /* ignore */ }
                            return;
                        }
                        const payload = chatToResponses(result.data, result.model);
                        if (wantStream) return writeSse(sseFramesForResponses(payload), metaOf(result));
                        return send(res, 200, payload, metaOf(result));
                    }

                    const result = await this.chatCompletion(body);
                    const meta = metaOf(result);
                    if (result.stream) {
                        try {
                            res.writeHead(200, {
                                'Content-Type': 'text/event-stream',
                                'Cache-Control': 'no-cache',
                                Connection: 'keep-alive',
                                ...meta,
                            });
                            result.stream.on('error', err => {
                                console.warn('[ProviderRouter] Upstream stream error:', err.message);
                                try { res.end(); } catch (e) {}
                            });
                            result.stream.pipe(res);
                        } catch (err) {
                            console.warn('[ProviderRouter] Failed to pipe stream:', err.message);
                        }
                        return;
                    }
                    send(res, 200, result.data, meta);
                })
                .catch(err => fail(res, err.status && err.status >= 400 ? err.status : 502,
                    String(err.message || err), 'upstream_failed', { attempts: err.attempts || [] }));
            return true;
        };
    }
}

module.exports = ProviderRouter;
module.exports.ProviderRouter = ProviderRouter;
module.exports.STRATEGIES = STRATEGIES;
module.exports.PRICE_TABLE = PRICE_TABLE;
module.exports.anthropicMessagesToChat = anthropicMessagesToChat;
module.exports.chatToAnthropicMessage = chatToAnthropicMessage;
module.exports.responsesToChat = responsesToChat;
module.exports.chatToResponses = chatToResponses;
module.exports.pipeOpenAiSse = pipeOpenAiSse;
module.exports.pipeOpenAiSseToAnthropic = pipeOpenAiSseToAnthropic;
module.exports.pipeOpenAiSseToResponses = pipeOpenAiSseToResponses;
