const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LoopGuard } = require('../core/LoopGuard');
const { TruncationEngine } = require('../core/TruncationEngine');
const { SecurityApprovalGate } = require('../core/SecurityApprovalGate');
const { HermesToolEngine } = require('../core/HermesToolEngine');

test('LoopGuard halts consecutive identical tool calls', () => {
    const guard = new LoopGuard({ maxToolRepetitions: 3 });
    const chatId = 'chat-test-loop';

    assert.equal(guard.checkToolCall(chatId, 'read_file', { path: 'a.js' }).isLoop, false);
    assert.equal(guard.checkToolCall(chatId, 'read_file', { path: 'a.js' }).isLoop, false);
    
    const trip = guard.checkToolCall(chatId, 'read_file', { path: 'a.js' });
    assert.equal(trip.isLoop, true);
    assert.match(trip.reason, /executed with identical arguments 3 times/);
});

test('LoopGuard detects circular ping-pong delegation between agents', () => {
    const guard = new LoopGuard({ maxCircularDelegations: 2 });
    const chatId = 'chat-test-pingpong';

    assert.equal(guard.checkDelegation(chatId, 'claude', 'codex', 'Fix bug').isLoop, false);
    
    const trip = guard.checkDelegation(chatId, 'claude', 'codex', 'Fix bug');
    assert.equal(trip.isLoop, true);
    assert.match(trip.reason, /Circular delegation detected/);
});

test('TruncationEngine leaves small output intact and truncates massive outputs', () => {
    const truncator = new TruncationEngine({ defaultMaxLength: 100, defaultHead: 20, defaultTail: 20 });
    
    // 1. Small output
    const small = truncator.truncate('Small output');
    assert.equal(small.truncated, false);
    assert.equal(small.text, 'Small output');

    // 2. Large output
    const large = 'A'.repeat(500);
    const result = truncator.truncate(large);
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes('OpenClaw Truncator'));
    assert.ok(result.text.length < 500);
    assert.ok(fs.existsSync(result.savedPath));

    // Cleanup saved log
    try { fs.unlinkSync(result.savedPath); } catch (_) {}
});

test('SecurityApprovalGate identifies destructive commands and gates execution', async () => {
    const gate = new SecurityApprovalGate({ timeoutMs: 1000 });

    assert.equal(gate.isDangerous('ls -la').dangerous, false);
    assert.equal(gate.isDangerous('git status').dangerous, false);
    assert.equal(gate.isDangerous('rm -rf /var/log').dangerous, true);
    assert.equal(gate.isDangerous('git reset --hard HEAD~1').dangerous, true);

    // Test async callback approval
    let mockMsgSent = false;
    let approvalId = null;
    const mockTelegram = {
        sendMessage: async (chatId, text, extra) => {
            mockMsgSent = true;
            approvalId = extra.reply_markup.inline_keyboard[0][0].callback_data.replace('approve:', '');
        },
    };

    const approvalPromise = gate.requestApproval('rm -rf ./tmp', {
        chatId: 'test-chat',
        agentName: 'Coder',
        telegram: mockTelegram,
    });

    assert.equal(mockMsgSent, true);
    assert.ok(approvalId);

    // User approves
    const callbackResult = gate.handleCallback(approvalId, true);
    assert.equal(callbackResult.handled, true);
    assert.equal(callbackResult.approved, true);

    const outcome = await approvalPromise;
    assert.equal(outcome.approved, true);
});

test('HermesToolEngine parses <thought> and <tool_call> and executes tool', async () => {
    const engine = new HermesToolEngine();
    const mockOutput = `
<thought>
I should read the package.json to inspect dependencies.
</thought>
<tool_call>
{"name": "read_file", "arguments": {"filePath": "package.json"}}
</tool_call>
Here is the plan.
    `;

    const parsed = engine.parseOutput(mockOutput);
    assert.ok(parsed.thought.includes('I should read the package.json'));
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'read_file');
    assert.equal(parsed.toolCalls[0].arguments.filePath, 'package.json');
    assert.equal(parsed.cleanText.includes('<thought>'), false);
    assert.equal(parsed.cleanText.includes('<tool_call>'), false);

    // Execute the parsed tool
    const resXml = await engine.executeTool(parsed.toolCalls[0], { workspaceDir: path.resolve(__dirname, '..') });
    assert.ok(resXml.includes('<tool_response>'));
    assert.ok(resXml.includes('"status": "success"'));
});
