// =============================================================================
//  core/TruncationEngine.js — Smart Tool Result Truncation & Context Protection
//
//  Adapted from OpenClaw's tool-result-truncation & agent-compaction-constants.
//  Protects LLM context windows from overflowing when commands produce massive outputs
//  (e.g. 10,000 lines of git logs, huge stack traces, large file dumps).
//
//  Preserves:
//    - Head (initial status, headers, early findings)
//    - Tail (final exit status, fatal errors, bottom summary)
//    - Saves the complete unabridged log to disk for reference.
// =============================================================================

const fs = require('fs');
const path = require('path');

class TruncationEngine {
    constructor({ defaultMaxLength = 8000, defaultHead = 2500, defaultTail = 2500, logsDir = null } = {}) {
        this.defaultMaxLength = defaultMaxLength;
        this.defaultHead = defaultHead;
        this.defaultTail = defaultTail;
        this.logsDir = logsDir || path.resolve(__dirname, '..', 'workspaces', 'outputs');
        try {
            if (!fs.existsSync(this.logsDir)) {
                fs.mkdirSync(this.logsDir, { recursive: true });
            }
        } catch (_) {}
    }

    /**
     * Truncate large tool or command output while preserving head and tail context.
     * Optionally saves the full output to disk.
     */
    truncate(output, { maxLength = null, headLength = null, tailLength = null, label = 'tool' } = {}) {
        const text = String(output ?? '');
        const max = maxLength || this.defaultMaxLength;
        const headSize = headLength || this.defaultHead;
        const tailSize = tailLength || this.defaultTail;

        if (text.length <= max) {
            return {
                text,
                truncated: false,
                originalLength: text.length,
            };
        }

        const omitted = text.length - headSize - tailSize;
        const omittedLines = (text.slice(headSize, -tailSize).match(/\n/g) || []).length;

        // Save full unclipped output to disk
        let savedPath = null;
        try {
            const fileName = `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`;
            savedPath = path.join(this.logsDir, fileName);
            fs.writeFileSync(savedPath, text, 'utf8');
        } catch (e) {
            console.warn(`[TruncationEngine] Could not save full output to disk: ${e.message}`);
        }

        const head = text.slice(0, headSize).trimEnd();
        const tail = text.slice(-tailSize).trimStart();

        const fileNotice = savedPath ? ` (Full unabridged output saved to: ${savedPath})` : '';
        const banner = `\n\n--- [ ⚠️ OpenClaw Truncator: ${omitted.toLocaleString()} characters (~${omittedLines} lines) omitted to protect context window${fileNotice} ] ---\n\n`;

        return {
            text: `${head}${banner}${tail}`,
            truncated: true,
            originalLength: text.length,
            savedPath,
            omittedChars: omitted,
        };
    }
}

const globalTruncator = new TruncationEngine();

module.exports = {
    TruncationEngine,
    globalTruncator,
};
