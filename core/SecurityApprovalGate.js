// =============================================================================
//  core/SecurityApprovalGate.js — Interactive Destructive Action Approval Gate
//
//  Adapted from OpenClaw's exec-approvals-runtime & security-runtime.
//  Intercepts potentially destructive operations (e.g. rm -rf, git reset --hard)
//  and presents an inline authorization prompt to the user before running.
// =============================================================================

class SecurityApprovalGate {
    constructor({ timeoutMs = 60000 } = {}) {
        this.timeoutMs = timeoutMs;
        this.pendingApprovals = new Map(); // id -> { resolve, reject, timer, command, agentName }
        this.dangerousPatterns = [
            /\brm\s+-(?:r|f|rf|fr)\b/i,
            /\brmdir\s+\/s\s+\/q\b/i,
            /\bdel\s+\/f\s+\/s\s+\/q\b/i,
            /\bgit\s+reset\s+--hard\b/i,
            /\bgit\s+clean\s+-(?:f|fd|xfd)\b/i,
            /\bgit\s+push\s+(?:--force|-f)\b/i,
            /\bdrop\s+(?:database|table)\b/i,
            /\btruncate\s+table\b/i,
            /\bformat\s+[a-z]:/i,
            /\bdd\s+if=/i,
            /\b(?:shutdown|reboot|poweroff|init\s+0)\b/i,
        ];
    }

    /**
     * Inspect if a command matches any destructive pattern.
     */
    isDangerous(command) {
        const cmd = String(command || '').trim();
        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(cmd)) {
                return { dangerous: true, pattern: pattern.toString() };
            }
        }
        return { dangerous: false };
    }

    /**
     * Request authorization for a dangerous command via Telegram.
     * Returns a Promise resolving to { approved: boolean, reason?: string }.
     */
    async requestApproval(command, { chatId, agentName = 'Agent', telegram = null, timeoutMs = null } = {}) {
        const check = this.isDangerous(command);
        if (!check.dangerous) {
            return { approved: true }; // Safe to run immediately
        }

        const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        return new Promise((resolve) => {
            const timeout = timeoutMs || this.timeoutMs;
            const timer = setTimeout(() => {
                this.pendingApprovals.delete(approvalId);
                resolve({ approved: false, reason: `Approval timed out after ${Math.round(timeout / 1000)}s` });
            }, timeout);

            this.pendingApprovals.set(approvalId, {
                resolve,
                timer,
                command,
                agentName,
                chatId,
                createdAt: Date.now(),
            });

            // Send interactive Telegram confirmation prompt if telegram instance provided
            if (telegram && chatId) {
                const text = `⚠️ <b>SECURITY APPROVAL REQUIRED</b>\n\n` +
                    `Agent <b>${agentName}</b> is attempting to run a potentially destructive command:\n\n` +
                    `<code>${command}</code>\n\n` +
                    `<i>Do you authorize running this command once?</i>`;

                const extra = {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Run Once', callback_data: `approve:${approvalId}` },
                                { text: '❌ Abort / Deny', callback_data: `deny:${approvalId}` },
                            ],
                        ],
                    },
                };

                telegram.sendMessage(chatId, text, extra).catch(err => {
                    console.warn(`[ApprovalGate] Failed sending approval prompt: ${err.message}`);
                });
            }
        });
    }

    /**
     * Handle user callback from Telegram (Approve / Deny button).
     */
    handleCallback(approvalId, approved) {
        const pending = this.pendingApprovals.get(approvalId);
        if (!pending) {
            return { handled: false, error: 'Approval request expired or already handled' };
        }

        clearTimeout(pending.timer);
        this.pendingApprovals.delete(approvalId);

        pending.resolve({ approved, reason: approved ? 'User authorized' : 'User denied' });
        return { handled: true, approved, command: pending.command };
    }
}

const globalApprovalGate = new SecurityApprovalGate();

module.exports = {
    SecurityApprovalGate,
    globalApprovalGate,
};
