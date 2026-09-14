// =============================================================================
//  core/ExfiltrationGuard.js — ClaudeClaw V3 Outbound Data Loss Prevention
//
//  Scans outgoing content before transmission (Telegram, Web, Email, Files)
//  and intercepts accidental leakage of API keys, tokens, or private secrets.
// =============================================================================

const LEAK_PATTERNS = [
    { name: 'Claude API Key', regex: /sk-ant-[A-Za-z0-9_\-]{30,}/g },
    { name: 'OpenAI API Key', regex: /sk-[A-Za-z0-9]{32,}/g },
    { name: 'Slack Token', regex: /xox[baprs]-[0-9A-Za-z\-]{20,}/g },
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

class ExfiltrationGuard {
    constructor(auditLogger = null) {
        this.auditLogger = auditLogger;
    }

    setAuditLogger(auditLogger) {
        this.auditLogger = auditLogger;
    }

    scanForLeaks(content) {
        if (!content || typeof content !== 'string') {
            return { safe: true, matches: [] };
        }

        const matches = [];
        for (const { name, regex } of LEAK_PATTERNS) {
            const found = content.match(regex);
            if (found && found.length > 0) {
                matches.push({ name, count: found.length });
            }
        }

        const isSafe = matches.length === 0;

        if (!isSafe && this.auditLogger) {
            try {
                this.auditLogger.logAudit(
                    'system',
                    'exfiltration_guard',
                    'exfil_blocked',
                    'outbound_message',
                    { matches }
                );
            } catch (e) {}
        }

        return {
            safe: isSafe,
            matches,
            redactedContent: isSafe ? content : this.redact(content)
        };
    }

    redact(content) {
        if (!content || typeof content !== 'string') return content;
        let redacted = content;
        for (const { regex } of LEAK_PATTERNS) {
            redacted = redacted.replace(regex, '[REDACTED_BY_EXFILTRATION_GUARD]');
        }
        return redacted;
    }
}

module.exports = ExfiltrationGuard;
