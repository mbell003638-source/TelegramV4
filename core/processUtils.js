function terminateChild(child, graceMs = 3000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

    return new Promise((resolve) => {
        let settled = false;
        let forceTimer = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
        };
        child.once('close', finish);
        try { child.kill('SIGTERM'); } catch { finish(); return; }
        forceTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish();
        }, graceMs);
        forceTimer.unref();
    });
}

module.exports = { terminateChild };
