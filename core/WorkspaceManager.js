// =============================================================================
//  core/WorkspaceManager.js — Workspace & Git Worktree Isolation Manager
//
//  Prevents parallel agent execution from colliding on:
//    - .git/index.lock files
//    - Simultaneous overwrites of source code
//    - Build artifact / cache corruption
// =============================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class WorkspaceManager {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.workspacesDir = path.join(this.baseDir, 'workspaces');
        if (!fs.existsSync(this.workspacesDir)) {
            fs.mkdirSync(this.workspacesDir, { recursive: true });
        }
    }

    /**
     * Get or create an isolated workspace for a parallel agent task
     */
    acquireWorkspace(taskId, repoRoot = null) {
        const targetDir = path.join(this.workspacesDir, `task_${taskId}`);
        if (fs.existsSync(targetDir)) return targetDir;

        fs.mkdirSync(targetDir, { recursive: true });

        // If repoRoot has a git repo, attempt to create a lightweight git worktree
        if (repoRoot && fs.existsSync(path.join(repoRoot, '.git'))) {
            try {
                const branchName = `agent-task-${taskId}`;
                execSync(`git worktree add -b ${branchName} "${targetDir}" HEAD`, {
                    cwd: repoRoot,
                    stdio: 'pipe',
                    windowsHide: true,
                    timeout: 10000,
                });
                return targetDir;
            } catch (err) {
                // If worktree creation fails (e.g. detached HEAD), fallback to isolated directory
            }
        }

        return targetDir;
    }

    /**
     * Clean up an isolated workspace once the task completes
     */
    releaseWorkspace(taskId, repoRoot = null) {
        const targetDir = path.join(this.workspacesDir, `task_${taskId}`);
        if (!fs.existsSync(targetDir)) return;

        if (repoRoot && fs.existsSync(path.join(repoRoot, '.git'))) {
            try {
                execSync(`git worktree remove --force "${targetDir}"`, {
                    cwd: repoRoot,
                    stdio: 'pipe',
                    windowsHide: true,
                    timeout: 10000,
                });
                return;
            } catch (err) {}
        }

        try {
            fs.rmSync(targetDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

const globalWorkspaceManager = new WorkspaceManager();

module.exports = {
    WorkspaceManager,
    globalWorkspaceManager,
};
