const path = require('path');

function numberEnv(name, fallback, min = 0) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

function booleanEnv(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = {
    baseDir: process.env.BRIDGE_BASE_DIR || path.resolve(__dirname, '..'),
    lockPort: numberEnv('BRIDGE_LOCK_PORT', 47200, 1),
    lockHost: process.env.BRIDGE_LOCK_HOST || '127.0.0.1',
    desktopHost: process.env.DESKTOP_HOST || '127.0.0.1',
    desktopPort: numberEnv('DESKTOP_PORT', 0, 0),
    desktopPath: process.env.DESKTOP_PATH || '/api/session/send',
    desktopTimeoutMs: numberEnv('DESKTOP_TIMEOUT_MS', 30000, 1000),
    agentTimeoutMs: numberEnv('AGENT_TIMEOUT_MS', 900000, 1000),
    shellCommandTimeoutMs: numberEnv('SHELL_COMMAND_TIMEOUT_MS', 900000, 1000),
    shellCommandMaxOutputBytes: numberEnv('SHELL_COMMAND_MAX_OUTPUT_BYTES', 65536, 1024),
    toolApprovalTimeoutMs: numberEnv('TOOL_APPROVAL_TIMEOUT_MS', 120000, 1000),
    reconnectBaseDelayMs: numberEnv('RECONNECT_BASE_DELAY_MS', 1000, 100),
    reconnectMaxDelayMs: numberEnv('RECONNECT_MAX_DELAY_MS', 30000, 1000),
    queueNoticeThreshold: numberEnv('QUEUE_NOTICE_THRESHOLD', 1, 0),
    streamUpdateIntervalMs: numberEnv('STREAM_UPDATE_INTERVAL_MS', 800, 250),
    typingRefreshIntervalMs: numberEnv('TYPING_REFRESH_INTERVAL_MS', 4000, 1000),
    telegramIpFamily: numberEnv('TELEGRAM_IP_FAMILY', 4, 0),
    telegramKeepAliveMs: numberEnv('TELEGRAM_KEEPALIVE_MS', 10000, 1000),
    dropPendingUpdates: booleanEnv('DROP_PENDING_UPDATES', false),
    mediaTimeoutMs: numberEnv('MEDIA_TIMEOUT_MS', 30000, 1000),
    mediaMaxBytes: numberEnv('MEDIA_MAX_BYTES', 20_000_000, 1024),
    uploadRetentionHours: numberEnv('UPLOAD_RETENTION_HOURS', 24, 1),
    modelCacheTtlMs: numberEnv('MODEL_CACHE_TTL_MS', 3600000, 1000),
    modelDiscoveryTimeoutMs: numberEnv('MODEL_DISCOVERY_TIMEOUT_MS', 15000, 1000),
    logFile: process.env.BRIDGE_LOG_FILE || path.join(process.env.BRIDGE_BASE_DIR || path.resolve(__dirname, '..'), 'bot.log'),
    logMaxBytes: numberEnv('BRIDGE_LOG_MAX_BYTES', 5_000_000, 1024),
    logBackups: numberEnv('BRIDGE_LOG_BACKUPS', 5, 1),
    maxConcurrentAgents: numberEnv('MAX_CONCURRENT_AGENTS', 4, 1),
};
