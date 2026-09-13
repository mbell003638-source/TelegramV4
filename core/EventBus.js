// =============================================================================
//  core/EventBus.js — Global Channel Event Bus
//
//  Decouples Agent responses from the Telegram presentation layer.
//  Agent emits events → EventBus → Gateway renders.
// =============================================================================
const EventEmitter = require('events');

const ChannelEvents = {
    AGENT_MESSAGE: 'channel.agent.message',
    AGENT_TOOL_CALL: 'channel.agent.tool_call',
    AGENT_STATUS: 'channel.agent.status',
    AGENT_FINISHED: 'channel.agent.finished',
    AGENT_ERROR: 'channel.agent.error',
};

class ChannelEventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
    }

    /**
     * Emit an agent text/stream chunk
     */
    emitAgentMessage(agentKey, data, requestId) {
        this.emit(ChannelEvents.AGENT_MESSAGE, { agentKey, requestId, ...data });
    }

    /**
     * Emit tool call event (agent is using a tool)
     */
    emitToolCall(agentKey, toolName, requestId) {
        this.emit(ChannelEvents.AGENT_TOOL_CALL, { agentKey, requestId, toolName });
    }

    /**
     * Emit status change (thinking, processing, etc.)
     */
    emitStatus(agentKey, message, requestId) {
        this.emit(ChannelEvents.AGENT_STATUS, { agentKey, requestId, message });
    }

    /**
     * Emit when agent finishes responding
     */
    emitFinished(agentKey, finalText, requestId) {
        this.emit(ChannelEvents.AGENT_FINISHED, { agentKey, requestId, finalText });
    }

    /**
     * Emit agent error
     */
    emitError(agentKey, error, requestId) {
        this.emit(ChannelEvents.AGENT_ERROR, { agentKey, requestId, error });
    }

    // Listener helpers
    onAgentMessage(handler) { this.on(ChannelEvents.AGENT_MESSAGE, handler); }
    onToolCall(handler) { this.on(ChannelEvents.AGENT_TOOL_CALL, handler); }
    onStatus(handler) { this.on(ChannelEvents.AGENT_STATUS, handler); }
    onFinished(handler) { this.on(ChannelEvents.AGENT_FINISHED, handler); }
    onError(handler) { this.on(ChannelEvents.AGENT_ERROR, handler); }
}

// Singleton channel event bus
const channelEventBus = new ChannelEventBus();

module.exports = { channelEventBus, ChannelEvents };
