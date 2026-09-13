// =============================================================================
//  core/LoopGuard.js — Loop & Runaway Execution Protection
//
//  Adapted from OpenClaw's tool-loop-detection & pair-loop-guard-runtime.
//  Protects autonomous agent swarms from:
//    1. Infinite repetitive tool calling (e.g. calling identical failing command 3+ times)
//    2. Circular agent ping-pong delegation (Agent A -> Agent B -> Agent A)
//    3. Token burn from runaway recursive loops
// =============================================================================

const crypto = require('crypto');

class LoopGuard {
    constructor({ maxToolRepetitions = 3, maxHistoryPerChat = 20, maxCircularDelegations = 2 } = {}) {
        this.maxToolRepetitions = maxToolRepetitions;
        this.maxHistoryPerChat = maxHistoryPerChat;
        this.maxCircularDelegations = maxCircularDelegations;
        this.history = new Map(); // chatId -> array of { type, signature, timestamp }
    }

    /**
     * Generate a deterministic signature for a tool call.
     */
    _getToolSignature(toolName, args) {
        const serialized = typeof args === 'string' ? args.trim() : JSON.stringify(args || {});
        return `${toolName}:${crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 12)}`;
    }

    /**
     * Record a tool invocation and check if a repetitive loop is occurring.
     * Returns { isLoop: boolean, reason?: string, count?: number }
     */
    checkToolCall(chatId, toolName, args = {}) {
        const sig = this._getToolSignature(toolName, args);
        const chatHistory = this._getHistory(chatId);

        let consecutiveMatches = 0;
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            const entry = chatHistory[i];
            if (entry.type === 'tool' && entry.signature === sig) {
                consecutiveMatches++;
            } else {
                break; // Not consecutive
            }
        }

        // Add this attempt to history
        chatHistory.push({ type: 'tool', signature: sig, toolName, timestamp: Date.now() });
        this._trimHistory(chatId);

        if (consecutiveMatches + 1 >= this.maxToolRepetitions) {
            return {
                isLoop: true,
                count: consecutiveMatches + 1,
                reason: `Tool '${toolName}' executed with identical arguments ${consecutiveMatches + 1} times consecutively. Halting loop to prevent token burn.`,
            };
        }

        return { isLoop: false };
    }

    /**
     * Check for circular ping-pong delegations between agents.
     * (e.g. Agent A hands off to Agent B, who hands off back to Agent A with same intent)
     */
    checkDelegation(chatId, fromAgent, toAgent, taskTitle) {
        const sig = `${fromAgent}->${toAgent}:${taskTitle.slice(0, 30).trim()}`;
        const chatHistory = this._getHistory(chatId);

        let occurrences = 0;
        for (const entry of chatHistory) {
            if (entry.type === 'delegation' && entry.signature === sig) {
                occurrences++;
            }
        }

        chatHistory.push({ type: 'delegation', signature: sig, timestamp: Date.now() });
        this._trimHistory(chatId);

        if (occurrences + 1 >= this.maxCircularDelegations) {
            return {
                isLoop: true,
                count: occurrences + 1,
                reason: `Circular delegation detected: ${fromAgent} ⇄ ${toAgent} for task '${taskTitle}'. Halting ping-pong loop.`,
            };
        }

        return { isLoop: false };
    }

    /**
     * Reset loop tracking for a chat session.
     */
    reset(chatId) {
        this.history.delete(chatId);
    }

    _getHistory(chatId) {
        if (!this.history.has(chatId)) {
            this.history.set(chatId, []);
        }
        return this.history.get(chatId);
    }

    _trimHistory(chatId) {
        const arr = this.history.get(chatId);
        if (arr && arr.length > this.maxHistoryPerChat) {
            this.history.set(chatId, arr.slice(-this.maxHistoryPerChat));
        }
    }
}

const globalLoopGuard = new LoopGuard();

module.exports = {
    LoopGuard,
    globalLoopGuard,
};
