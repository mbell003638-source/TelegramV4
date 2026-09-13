// =============================================================================
//  core/HermesToolEngine.js — Nous Research Hermes Function-Calling Engine
//
//  Implements the Nous Research Hermes-Function-Calling & Hermes-Agent protocol:
//    - Scratchpad parsing (<thought>...</thought>)
//    - Structured XML tool invocation (<tool_call>...</tool_call>)
//    - Tool response synthesis (<tool_response>...</tool_response>)
//    - Hermes Self-Correction Reflection loop on tool errors
// =============================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { globalTruncator } = require('./TruncationEngine');
const { globalLoopGuard } = require('./LoopGuard');
const { globalApprovalGate } = require('./SecurityApprovalGate');

class HermesToolEngine {
    constructor() {
        this.tools = new Map();
        this._registerDefaultTools();
    }

    /**
     * Register a callable tool.
     */
    registerTool(name, description, parameters, handler) {
        this.tools.set(name, {
            name,
            description,
            parameters,
            handler,
        });
    }

    /**
     * Parse text for Hermes <thought> and <tool_call> tags.
     */
    parseOutput(text) {
        const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
        const thought = thoughtMatch ? thoughtMatch[1].trim() : null;

        const toolCalls = [];
        const toolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
        let match;
        while ((match = toolRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed && parsed.name) {
                    toolCalls.push({
                        name: parsed.name,
                        arguments: parsed.arguments || {},
                        raw: match[1].trim(),
                    });
                }
            } catch (e) {
                console.warn(`[HermesEngine] Failed parsing tool call JSON: ${match[1]}`);
            }
        }

        // Clean user-facing text by removing thought and tool_call tags
        const cleanText = text
            .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
            .trim();

        return { thought, toolCalls, cleanText };
    }

    /**
     * Execute a parsed tool call with safety guardrails (LoopGuard, Truncator, ApprovalGate).
     */
    async executeTool(toolCall, { chatId = 'default', workspaceDir = process.cwd() } = {}) {
        const { name, arguments: args } = toolCall;

        // 1. Loop Guard: Check for repetitive execution
        const loopCheck = globalLoopGuard.checkToolCall(chatId, name, args);
        if (loopCheck.isLoop) {
            return this.formatToolResponse(name, {
                status: 'error',
                error: loopCheck.reason,
            });
        }

        const tool = this.tools.get(name);
        if (!tool) {
            return this.formatToolResponse(name, {
                status: 'error',
                error: `Tool '${name}' is not recognized. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
            });
        }

        try {
            const rawResult = await tool.handler(args, { workspaceDir, chatId });
            const truncated = globalTruncator.truncate(rawResult, { label: name });
            return this.formatToolResponse(name, {
                status: 'success',
                data: truncated.text,
            });
        } catch (err) {
            return this.formatToolResponse(name, {
                status: 'error',
                error: `${err.message}\nReflect in <thought> on why this failed and adjust your parameters or strategy.`,
            });
        }
    }

    /**
     * Format execution result into standard Hermes <tool_response> XML.
     */
    formatToolResponse(name, payload) {
        return `<tool_response>\n${JSON.stringify({ name, ...payload }, null, 2)}\n</tool_response>`;
    }

    /**
     * Get JSON schema tool definitions for system prompts.
     */
    getToolDefinitions() {
        return Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    }

    _registerDefaultTools() {
        // 1. Bash / Shell execution
        this.registerTool('bash', 'Execute a command in the bash shell', {
            type: 'object',
            properties: { command: { type: 'string', description: 'Command to run' } },
            required: ['command'],
        }, async ({ command }, { workspaceDir }) => {
            const check = globalApprovalGate.isDangerous(command);
            if (check.dangerous) {
                throw new Error(`Destructive command blocked by SecurityApprovalGate: ${command}`);
            }
            return new Promise((resolve) => {
                exec(command, { cwd: workspaceDir, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                    const output = (stdout || stderr || '').trim();
                    if (err) {
                        resolve(`Exit code ${err.code || 1}\n${output}\n${err.message}`);
                    } else {
                        resolve(output || '(Success with no output)');
                    }
                });
            });
        });

        // 2. Read File
        this.registerTool('read_file', 'Read contents of a file', {
            type: 'object',
            properties: { filePath: { type: 'string', description: 'Relative path to file' } },
            required: ['filePath'],
        }, async ({ filePath }, { workspaceDir }) => {
            const resolved = path.resolve(workspaceDir, filePath);
            if (!fs.existsSync(resolved)) {
                throw new Error(`File not found: ${filePath}`);
            }
            return fs.readFileSync(resolved, 'utf8');
        });

        // 3. Write File
        this.registerTool('write_file', 'Write content to a file', {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Relative path to file' },
                content: { type: 'string', description: 'File contents to write' },
            },
            required: ['filePath', 'content'],
        }, async ({ filePath, content }, { workspaceDir }) => {
            const resolved = path.resolve(workspaceDir, filePath);
            const parent = path.dirname(resolved);
            if (!fs.existsSync(parent)) {
                fs.mkdirSync(parent, { recursive: true });
            }
            fs.writeFileSync(resolved, content, 'utf8');
            return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${filePath}`;
        });
    }
}

const globalHermesEngine = new HermesToolEngine();

module.exports = {
    HermesToolEngine,
    globalHermesEngine,
};
