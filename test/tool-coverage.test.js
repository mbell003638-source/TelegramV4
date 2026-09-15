// =============================================================================
//  test/tool-coverage.test.js — Hermes / OpenClaw capability inventory
//
//  The standing product request is "it should have all tools of hermes and
//  openclaw; base should be hermes and openclaw". Honesty rule from
//  REQUIREMENTS.md: those repos cannot be merged (Hermes is Python, OpenClaw
//  is ~42k files of TypeScript). Capabilities are reimplemented natively.
//
//  This file is the contract for that claim:
//    1. HermesToolEngine exposes the important capabilities that WERE ported.
//    2. Each of those has a native module in core/ (not a vendored copy).
//    3. HermesAgent / OpenClawAgent wrap the real CLIs — they are the base.
//    4. Full Python Hermes and full OpenClaw TypeScript are intentionally
//       NOT ported, and their extra tools are absent from this engine.
//
//  Does NOT import C:\Ai\hermes-agent or C:\Ai\openclaw.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { HermesToolEngine } = require('../core/HermesToolEngine');

const ROOT = path.resolve(__dirname, '..');

function engineNames() {
    return new HermesToolEngine().getToolDefinitions().map(d => d.name);
}

function exists(...parts) {
    return fs.existsSync(path.join(ROOT, ...parts));
}

// ---------------------------------------------------------------------------
//  What WAS ported — tool name, present in the engine, native module
// ---------------------------------------------------------------------------

const PORTED = [
    // Bare-model (Hermes terminal / read_file / write_file; OpenClaw exec / read / write)
    { capability: 'shell',            hermes: 'terminal',          openclaw: 'exec',             tool: 'bash',               module: 'core/HermesToolEngine.js' },
    { capability: 'read file',        hermes: 'read_file',         openclaw: 'read',             tool: 'read_file',          module: 'core/HermesToolEngine.js' },
    { capability: 'write file',       hermes: 'write_file',        openclaw: 'write',            tool: 'write_file',         module: 'core/HermesToolEngine.js' },
    // Memory (Hermes memory / session_search; OpenClaw has no single memory tool — hive-mind here)
    { capability: 'memory search',    hermes: 'memory',            openclaw: 'session_status*',  tool: 'recall_memory',      module: 'core/MemorySearch.js' },
    { capability: 'memory write',     hermes: 'memory',            openclaw: '(native hive)',    tool: 'remember',           module: 'core/Database.js' },
    // Swarm / skills (Hermes delegate_task, skills_list; OpenClaw agents_list, subagents, skills)
    { capability: 'agent roster',     hermes: 'delegate_task',     openclaw: 'agents_list',      tool: 'list_agents',        module: 'core/AgentPool.js' },
    { capability: 'delegation',       hermes: 'delegate_task',     openclaw: 'subagents',        tool: 'delegate_to_agent',  module: 'core/AgentDelegation.js' },
    { capability: 'skill catalogue',  hermes: 'skills_list',       openclaw: 'skills',           tool: 'list_skills',        module: 'core/SkillRegistry.js' },
    { capability: 'skill invoke',     hermes: 'skill_view',        openclaw: 'skills',           tool: 'use_skill',          module: 'core/SkillRegistry.js' },
    // Cron (Hermes cronjob_manage; OpenClaw cron)
    { capability: 'scheduler',        hermes: 'cronjob_manage',    openclaw: 'cron',             tool: 'cron',               module: 'core/Scheduler.js' },
    // Devices (Hermes computer_use is desktop CUA; we port OpenClaw-style nodes as ADB)
    { capability: 'devices',          hermes: 'computer_use*',     openclaw: 'nodes',            tool: 'device',             module: 'core/DeviceAutomation.js' },
    // Syncthing — native to this stack; neither upstream has it
    { capability: 'syncthing',        hermes: '(not upstream)',    openclaw: '(not upstream)',   tool: 'syncthing',          module: 'core/SyncthingBridge.js' },
    // Meeting bot — native; OpenClaw has no Recall.ai join tool
    { capability: 'meeting bot',      hermes: '(not upstream)',    openclaw: '(not upstream)',   tool: 'meeting',            module: 'core/MeetingBot.js' },
    // Autonomous goals — native spine; neither upstream exposes a persistent goal engine
    { capability: 'autonomous goals', hermes: '(not upstream)',    openclaw: '(not upstream)',   tool: 'goal',               module: 'core/GoalEngine.js' },
];

// ---------------------------------------------------------------------------
//  Intentionally NOT ported — full Python Hermes / full OpenClaw TypeScript
// ---------------------------------------------------------------------------

const NOT_PORTED = [
    { tool: 'web_search',        reason: 'No native core/ module. Web search lives in the wrapped Hermes/OpenClaw/Claude CLIs, which already do it; the orchestration engine does not reimplement it.' },
    { tool: 'web_extract',       reason: 'Same as web_search — agent CLI, not engine.' },
    { tool: 'web_fetch',         reason: 'OpenClaw web_fetch; same as above.' },
    { tool: 'x_search',          reason: 'Hermes/OpenClaw xAI search. No native module.' },
    { tool: 'browser',           reason: 'Full browser automation is Python (Hermes) / TypeScript (OpenClaw). Not reimplemented.' },
    { tool: 'browser_navigate',  reason: 'Part of Hermes browser_* suite. Not reimplemented.' },
    { tool: 'image_generate',    reason: 'Provider-backed media gen. Not reimplemented.' },
    { tool: 'video_generate',    reason: 'Provider-backed media gen. Not reimplemented.' },
    { tool: 'text_to_speech',    reason: 'Hermes tts tool. Telegram TTS exists elsewhere; not an engine tool.' },
    { tool: 'execute_code',      reason: 'Hermes code_execution / OpenClaw code_execution. Not reimplemented.' },
    { tool: 'code_execution',    reason: 'OpenClaw code-mode / code_execution. Not reimplemented.' },
    { tool: 'computer_use',      reason: 'Hermes desktop CUA (screenshots + OS cursor). We port ADB phone/TV control as `device`, not desktop CUA.' },
    { tool: 'ha_call_service',   reason: 'Hermes Home Assistant. No HA module in this stack.' },
    { tool: 'apply_patch',       reason: 'OpenClaw apply_patch. Bare-model case has write_file; agent CLIs have their own patch tools.' },
    { tool: 'ask_user',          reason: 'OpenClaw structured prompt. Not reimplemented.' },
    { tool: 'plugins',           reason: 'OpenClaw plugin lifecycle. Not reimplemented.' },
    { tool: 'tool_search',       reason: 'OpenClaw catalog search / Code Mode. Not reimplemented.' },
    { tool: 'mcp',               reason: 'Hermes/OpenClaw MCP hosts. Not reimplemented.' },
    { tool: 'kanban_create',     reason: 'Hermes kanban_* dispatcher. Dashboard tasks exist; not an engine tool.' },
];

test('engine surface includes every ported Hermes/OpenClaw capability', () => {
    const names = engineNames();
    for (const row of PORTED) {
        assert.ok(names.includes(row.tool), `missing ported tool '${row.tool}' (${row.capability})`);
        assert.ok(exists(row.module), `native module missing for ${row.capability}: ${row.module}`);
    }
});

test('intentionally-not-ported Hermes/OpenClaw tools are absent from the engine', () => {
    const names = new Set(engineNames());
    for (const row of NOT_PORTED) {
        assert.equal(names.has(row.tool), false, `engine unexpectedly grew '${row.tool}' — ${row.reason}`);
    }
    // The engine must not pretend to be the full Python/TS tool catalogs.
    assert.ok(names.size < 30, `engine tool count ${names.size} looks like a vendored catalog, not an orchestration surface`);
});

test('Hermes and OpenClaw CLIs are the base agents, not vendored source trees', () => {
    assert.ok(exists('agents', 'HermesAgent.js'), 'HermesAgent wrapper missing');
    assert.ok(exists('agents', 'OpenClawAgent.js'), 'OpenClawAgent wrapper missing');

    const hermesSrc = fs.readFileSync(path.join(ROOT, 'agents', 'HermesAgent.js'), 'utf8');
    const openclawSrc = fs.readFileSync(path.join(ROOT, 'agents', 'OpenClawAgent.js'), 'utf8');
    assert.match(hermesSrc, /spawn\(this\.hermesPath/);
    assert.match(openclawSrc, /spawn\(this\.openclawPath/);
    assert.match(hermesSrc, /class HermesAgent/);
    assert.match(openclawSrc, /class OpenClawAgent/);

    // This repo must not vendor the upstream trees.
    assert.equal(exists('tools', 'registry.py'), false, 'do not vendor hermes-agent Python tools/');
    assert.equal(exists('src', 'agents', 'tools'), false, 'do not vendor openclaw TypeScript src/');
    assert.equal(exists('hermes-agent'), false);
    assert.equal(exists('openclaw'), false);
});

test('native collaborators for cron/device/syncthing/meeting/skills/goals actually export the methods the engine calls', () => {
    const Scheduler = require('../core/Scheduler');
    const { DeviceAutomation } = require('../core/DeviceAutomation');
    const SyncthingBridge = require('../core/SyncthingBridge');
    const MeetingBot = require('../core/MeetingBot');
    const SkillRegistry = require('../core/SkillRegistry');
    const GoalEngine = require('../core/GoalEngine');

    assert.equal(typeof Scheduler.prototype.listTasks, 'function');
    assert.equal(typeof Scheduler.prototype.scheduleTask, 'function');
    assert.equal(typeof Scheduler.prototype.cancelTask, 'function');

    assert.equal(typeof DeviceAutomation.prototype.listDevices, 'function');
    assert.equal(typeof DeviceAutomation.prototype.tap, 'function');
    assert.equal(typeof DeviceAutomation.prototype.captureScreenshot, 'function');
    assert.equal(typeof DeviceAutomation.prototype.remoteKey, 'function');

    assert.equal(typeof SyncthingBridge.prototype.overview, 'function');
    assert.equal(typeof SyncthingBridge.prototype.rescan, 'function');

    assert.equal(typeof MeetingBot.prototype.join, 'function');
    assert.equal(typeof MeetingBot.prototype.leave, 'function');
    assert.equal(typeof MeetingBot.prototype.transcript, 'function');
    assert.equal(typeof MeetingBot.prototype.speak, 'function');
    assert.equal(typeof MeetingBot.prototype.listActive, 'function');

    assert.equal(typeof SkillRegistry.prototype.list, 'function');
    assert.equal(typeof SkillRegistry.prototype.use, 'function');
    assert.equal(typeof SkillRegistry.prototype.get, 'function');

    assert.equal(typeof GoalEngine.prototype.create, 'function');
    assert.equal(typeof GoalEngine.prototype.list, 'function');
    assert.equal(typeof GoalEngine.prototype.step, 'function');
    assert.equal(typeof GoalEngine.prototype.get, 'function');
    assert.equal(typeof GoalEngine.prototype.abandon, 'function');
    assert.equal(typeof GoalEngine.prototype.resume, 'function');
    assert.equal(typeof GoalEngine.prototype.summary, 'function');
});

test('coverage table stays aligned with the live engine (no stale rows)', () => {
    const names = engineNames();
    const portedTools = PORTED.map(r => r.tool);
    for (const name of names) {
        assert.ok(
            portedTools.includes(name),
            `engine tool '${name}' is not in the PORTED inventory — add a row or it is undocumented`
        );
    }
    const unique = new Set(portedTools);
    assert.equal(unique.size, portedTools.length, 'PORTED inventory has duplicate tool names');
    assert.equal(names.length, unique.size);
});
