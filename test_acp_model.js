const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const sdk = require('@agentclientprotocol/sdk');

async function test() {
    const child = spawn('/home/open/.npm-global/bin/opencode', ['acp'], {
        cwd: '/home/open',
        env: { ...process.env, CI: 'true', PATH: '/home/open/.npm-global/bin:' + process.env.PATH }
    });
    const rawReadable = Readable.toWeb(child.stdout);
    const rawWritable = Writable.toWeb(child.stdin);
    const stream = sdk.ndJsonStream(rawWritable, rawReadable);
    let output = '';

    const conn = new sdk.ClientSideConnection(
        () => ({
            sessionUpdate: async (p) => {
                if (p.update?.sessionUpdate === 'agent_message_chunk' && p.update.content?.text) {
                    output += p.update.content.text;
                }
            },
            requestPermission: async () => ({ outcome: { outcome: 'approved' } })
        }),
        stream
    );

    await conn.initialize({ clientInfo: { name: 'Test', version: '1.0' }, protocolVersion: sdk.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.newSession({ cwd: '/home/open', mcpServers: [] });
    console.log('Session created:', s.sessionId);
    
    // Set model
    try {
        console.log('Setting model to tokenrouter/z-ai/glm-5.3-free...');
        await conn.unstable_setSessionModel({ sessionId: s.sessionId, modelId: 'tokenrouter/z-ai/glm-5.3-free' });
        console.log('Model set via unstable_setSessionModel');
    } catch(e) {
        console.log('unstable_setSessionModel failed:', e.message);
        try {
            await conn.setSessionConfigOption({ sessionId: s.sessionId, configId: 'model', type: 'string', value: 'tokenrouter/z-ai/glm-5.3-free' });
            console.log('Model set via setSessionConfigOption');
        } catch(e2) {
            console.log('setSessionConfigOption failed:', e2.message);
        }
    }

    await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: 'what model are you using? Answer in one short sentence.' }] });
    console.log('AI Response:', output);
    child.kill();
    process.exit(0);
}
test().catch(e => { console.error('Error:', e); process.exit(1); });
