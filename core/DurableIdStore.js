const fs = require('fs');
const path = require('path');

class DurableIdStore {
    constructor(file, limit = 1000, debounceMs = 150) {
        this.file = file;
        this.limit = limit;
        this.debounceMs = debounceMs;
        this.ids = this._load();
        this.timer = null;
        this.writePromise = Promise.resolve();
    }
    _load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            return new Set(Array.isArray(data) ? data : []);
        } catch { return new Set(); }
    }
    has(id) { return this.ids.has(String(id)); }
    add(id) {
        this.ids.add(String(id));
        while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.flush().catch(err => console.error(`[DurableIdStore] ${err.message}`)); }, this.debounceMs);
        if (this.timer.unref) this.timer.unref();
    }
    async flush() {
        clearTimeout(this.timer);
        this.timer = null;
        const data = JSON.stringify([...this.ids]);
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        this.writePromise = this.writePromise.then(async () => {
            await fs.promises.writeFile(tmp, data, 'utf8');
            await fs.promises.rename(tmp, this.file).catch(async err => {
                if (!['EEXIST', 'EPERM'].includes(err.code)) throw err;
                await fs.promises.rm(this.file, { force: true });
                await fs.promises.rename(tmp, this.file);
            });
        });
        return this.writePromise;
    }
}

module.exports = DurableIdStore;
