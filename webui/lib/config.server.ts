/**
 * Server-only configuration values that require Node built-ins.
 *
 * Do NOT import this file from a 'use client' component or any module a
 * client component imports -- `fs`/`os`/`path` are not available in the
 * browser bundle and will break the build. Client-safe values live in
 * `./config.ts`.
 */
import os from 'os';
import path from 'path';

/**
 * Default local Obsidian vault root, overridable via OBSIDIAN_VAULT_PATH.
 * Falls back to `<home>/Documents/ObsidianVault` for whichever machine/user
 * account this happens to run under, instead of a hardcoded foreign path.
 */
export const OBSIDIAN_VAULT: string =
  process.env.OBSIDIAN_VAULT_PATH || path.join(os.homedir(), 'Documents', 'ObsidianVault');
