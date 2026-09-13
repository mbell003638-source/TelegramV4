const { spawn } = require('child_process');
const proc = spawn('opencode', ['--continue'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
proc.stdout.on('data', d => console.log('OUT:', d.toString()));
proc.stderr.on('data', d => console.log('ERR:', d.toString()));
setTimeout(() => {
    console.log('Sending Hi...');
    proc.stdin.write('Hi\n');
}, 3000);
setTimeout(() => {
    proc.kill();
    process.exit(0);
}, 10000);
