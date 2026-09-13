// =============================================================================
//  core/formatters.js — Markdown → Telegram HTML Conversion
//
//  Converts agent responses (which come as markdown) into Telegram-safe HTML.
//  Without this, **bold**, `code`, etc. render as literal characters.
//
//  Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
// =============================================================================

/**
 * Convert markdown-formatted text to Telegram HTML.
 * Handles: bold, italic, strikethrough, code blocks, inline code, links.
 */
function markdownToTelegramHtml(text) {
    if (!text) return '';

    let result = text;

    // Escape HTML special characters FIRST (except in code blocks)
    // We'll handle code blocks separately to preserve their content
    const codeBlocks = [];
    let blockIndex = 0;

    // Extract fenced code blocks (```...```) and preserve them
    result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const placeholder = `@@CODEBLOCK_${blockIndex}@@`;
        codeBlocks.push({ placeholder, lang, code: escapeHtml(code.trimEnd()) });
        blockIndex++;
        return placeholder;
    });

    // Extract inline code (`...`) and preserve them
    const inlineCode = [];
    let inlineIndex = 0;
    result = result.replace(/`([^`]+)`/g, (_, code) => {
        const placeholder = `@@INLINECODE_${inlineIndex}@@`;
        inlineCode.push({ placeholder, code: escapeHtml(code) });
        inlineIndex++;
        return placeholder;
    });

    // Extract <thought>...</thought> (Hermes scratchpad / reasoning tags)
    const thoughtBlocks = [];
    let thoughtIndex = 0;
    result = result.replace(/<thought>([\s\S]*?)<\/thought>/gi, (_, thought) => {
        const placeholder = `@@THOUGHT_${thoughtIndex}@@`;
        thoughtBlocks.push({ placeholder, thought: escapeHtml(thought.trim()) });
        thoughtIndex++;
        return placeholder;
    });

    // Extract <tool_call>...</tool_call> (Hermes structured tool calling)
    const toolCallBlocks = [];
    let toolIndex = 0;
    result = result.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (_, toolCall) => {
        const placeholder = `@@TOOLCALL_${toolIndex}@@`;
        let toolName = 'tool';
        let toolArgs = '';
        try {
            const parsed = JSON.parse(toolCall.trim());
            toolName = parsed.name || 'tool';
            toolArgs = parsed.arguments ? JSON.stringify(parsed.arguments) : '';
        } catch (_) {
            toolArgs = toolCall.trim();
        }
        toolCallBlocks.push({ placeholder, name: escapeHtml(toolName), args: escapeHtml(toolArgs) });
        toolIndex++;
        return placeholder;
    });

    // Now escape HTML in the remaining text
    result = escapeHtml(result);

    // Convert markdown formatting to HTML
    // Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__(.+?)__/g, '<b>$1</b>');

    // Italic: *text* or _text_ (be careful not to match mid-word underscores)
    result = result.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
    result = result.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

    // Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Restore code blocks
    for (const block of codeBlocks) {
        const tag = block.lang ? `<pre><code class="language-${block.lang}">` : '<pre>';
        const closeTag = block.lang ? '</code></pre>' : '</pre>';
        result = result.replace(block.placeholder, `${tag}${block.code}${closeTag}`);
    }

    // Restore inline code
    for (const inline of inlineCode) {
        result = result.replace(inline.placeholder, `<code>${inline.code}</code>`);
    }

    // Restore thought blocks as Telegram expandable blockquotes
    for (const item of thoughtBlocks) {
        result = result.replace(item.placeholder, `<blockquote expandable><b>💭 Hermes Thinking:</b>\n${item.thought}</blockquote>\n\n`);
    }

    // Restore tool call blocks
    for (const item of toolCallBlocks) {
        result = result.replace(item.placeholder, `🔧 <code>${item.name}(${item.args})</code>\n`);
    }

    return result;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = { markdownToTelegramHtml, escapeHtml };
