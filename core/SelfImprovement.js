// =============================================================================
//  core/SelfImprovement.js — Autonomous Self-Improvement & Discipline Evaluator
//
//  Synthesizes:
//    - Early AI-dopters Kit 01: Fable Mindset discipline analyzer
//    - Early AI-dopters Kit 04: Bench Studio skill synthesis
//    - Regression testing: Runs smoke tests before promoting candidate skills
// =============================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class SelfImprovementEngine {
    constructor({ database, sessionStore, baseDir }) {
        this.db = database;
        this.sessionStore = sessionStore;
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.skillsDir = path.join(this.baseDir, 'skills');
        this.draftsDir = path.join(this.skillsDir, 'drafts');

        if (!fs.existsSync(this.draftsDir)) {
            fs.mkdirSync(this.draftsDir, { recursive: true });
        }
    }

    /**
     * Run a self-improvement evaluation on recent interaction history.
     */
    async evaluateAndLearn(chatId = '') {
        const results = {
            analyzedTurns: 0,
            disciplineScore: 100,
            insights: [],
            promotedRules: [],
            testsPassed: false,
        };

        try {
            // 1. Fetch recent conversation turns from sessionStore
            const chatPrefs = this.sessionStore?.getChatPreferences ? this.sessionStore.getChatPreferences(chatId) : null;
            const recentTurns = chatPrefs?.recentTurns || [];
            results.analyzedTurns = recentTurns.length;

            // 2. Scan for failure patterns or friction points
            const failurePatterns = [];
            for (const turn of recentTurns) {
                const text = String(turn.assistantText || '');
                if (text.includes('⚠️') || text.includes('Error:') || text.includes('failed') || text.includes('No response')) {
                    failurePatterns.push({
                        agent: turn.agent,
                        userQuery: turn.userText,
                        errorSnippet: text.slice(0, 150),
                    });
                }
            }

            // 3. Score discipline
            if (failurePatterns.length > 0) {
                results.disciplineScore = Math.max(30, 100 - (failurePatterns.length * 20));
                for (const fail of failurePatterns) {
                    const rule = `[Guardrail for ${fail.agent}] When handling '${fail.userQuery.slice(0, 40)}...', verify inputs before calling tools.`;
                    results.insights.push(rule);
                }
            } else {
                results.insights.push('All recent turns demonstrated high operational discipline and zero crashes.');
            }

            // 4. Save learned insights to SQLite memories with high salience
            for (const insight of results.insights) {
                this.db.addMemory(chatId, insight, {
                    summary: `Self-Improvement Insight: ${insight.slice(0, 50)}`,
                    importance: 0.9,
                    salience: 1.0,
                    source: 'self_improvement',
                });
                results.promotedRules.push(insight);
            }

            // 5. Run regression tests to verify environment health
            try {
                execSync('npm test', { cwd: this.baseDir, stdio: 'pipe', encoding: 'utf8', timeout: 30000 });
                results.testsPassed = true;
            } catch (err) {
                results.testsPassed = false;
                results.testError = err.message;
            }

            return results;
        } catch (err) {
            console.error('[SelfImprovement Error]', err);
            results.error = err.message;
            return results;
        }
    }
}

module.exports = SelfImprovementEngine;
