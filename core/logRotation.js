const fs = require('fs');
const path = require('path');

function rotateLogs(file, maxBytes, backups) {
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return false;
        for (let i = backups - 1; i >= 1; i--) {
            const from = `${file}.${i}`;
            const to = `${file}.${i + 1}`;
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        fs.renameSync(file, `${file}.1`);
        return true;
    } catch (err) {
        console.error(`[LogRotation] Unable to rotate ${path.basename(file)}: ${err.message}`);
        return false;
    }
}

module.exports = { rotateLogs };
