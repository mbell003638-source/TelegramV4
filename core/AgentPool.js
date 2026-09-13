// =============================================================================
//  core/AgentPool.js — Dynamic Agent Concurrency Pool & Scheduler
//
//  Features:
//    - User-controllable max concurrency (default 4 for 32GB RAM)
//    - Priority-based queueing (Urgent > Normal > Low)
//    - Dynamic runtime adjustment via Telegram (/concurrency <N>) or Dashboard
//    - Tracks active agent processes and memory headroom
// =============================================================================
const EventEmitter = require('events');
const os = require('os');
const config = require('./config');

class AgentPool extends EventEmitter {
    constructor(maxConcurrent = null) {
        super();
        const configured = maxConcurrent || config.maxConcurrentAgents || 4;
        this.maxConcurrent = Math.max(1, Number(configured) || 4);
        this.running = new Map(); // slotId -> { agentKey, startedAt, priority, description }
        this.queue = [];          // Array of { slotId, agentKey, priority, description, resolve }
    }

    /**
     * Get current pool status & memory metrics
     */
    getStatus() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memUsagePercent = Math.round((usedMem / totalMem) * 100);

        return {
            maxConcurrent: this.maxConcurrent,
            runningCount: this.running.size,
            queuedCount: this.queue.length,
            availableSlots: Math.max(0, this.maxConcurrent - this.running.size),
            memory: {
                totalGB: (totalMem / (1024 ** 3)).toFixed(1),
                freeGB: (freeMem / (1024 ** 3)).toFixed(1),
                usedPercent: memUsagePercent,
            },
            activeTasks: Array.from(this.running.entries()).map(([id, info]) => ({
                slotId: id,
                agentKey: info.agentKey,
                elapsedMs: Date.now() - info.startedAt,
                description: info.description || '',
            })),
        };
    }

    /**
     * Set max concurrency limit at runtime
     */
    setMaxConcurrent(limit) {
        const n = Math.max(1, parseInt(limit, 10));
        if (Number.isNaN(n)) return false;

        const previous = this.maxConcurrent;
        this.maxConcurrent = n;
        this.emit('pool.limit_changed', { previous, current: n });

        // If we expanded the pool, drain the queue
        this._drainQueue();
        return true;
    }

    /**
     * Acquire an execution slot
     */
    async acquire(slotId, { agentKey = 'agent', priority = 0, description = '' } = {}) {
        // Can we run immediately?
        if (this.running.size < this.maxConcurrent) {
            this.running.set(slotId, {
                agentKey,
                startedAt: Date.now(),
                priority,
                description,
            });
            this.emit('pool.slot_acquired', { slotId, agentKey, running: this.running.size });
            return true;
        }

        // Must wait in priority queue
        return new Promise((resolve) => {
            this.queue.push({
                slotId,
                agentKey,
                priority,
                description,
                resolve,
            });

            // Highest priority first, oldest first on tie
            this.queue.sort((a, b) => b.priority - a.priority);
            this.emit('pool.task_queued', { slotId, agentKey, queueLength: this.queue.length });
        });
    }

    /**
     * Release an execution slot
     */
    release(slotId) {
        if (!this.running.has(slotId)) return;

        const info = this.running.get(slotId);
        this.running.delete(slotId);
        this.emit('pool.slot_released', { slotId, agentKey: info?.agentKey, running: this.running.size });

        // Wake next in line
        this._drainQueue();
    }

    _drainQueue() {
        while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
            const next = this.queue.shift();
            this.running.set(next.slotId, {
                agentKey: next.agentKey,
                startedAt: Date.now(),
                priority: next.priority,
                description: next.description,
            });
            this.emit('pool.slot_acquired', { slotId: next.slotId, agentKey: next.agentKey, running: this.running.size });
            next.resolve(true);
        }
    }
}

// Global pool singleton
const globalAgentPool = new AgentPool();

module.exports = {
    AgentPool,
    globalAgentPool,
};
