/**
 * Central, client-safe configuration for the WebUI -> Bridge connection.
 *
 * IMPORTANT: this module must stay free of Node built-ins (fs / os / path /
 * child_process, etc.) because it is imported directly by 'use client'
 * components and gets bundled for the browser. Values that require Node APIs
 * (e.g. filesystem paths) live in `./config.server.ts` instead, which must
 * only be imported from server-only code (API routes, other server modules).
 *
 * Client-exposed values must be prefixed with NEXT_PUBLIC_ so Next.js inlines
 * them into the browser bundle at build time -- a plain (non-prefixed) env var
 * is only ever visible on the server.
 */

/** Base origin of the Agentic OS / ClaudeClaw bridge server (core/index.js). */
export const BRIDGE_URL: string =
  process.env.NEXT_PUBLIC_BRIDGE_URL || 'http://localhost:3141';

/**
 * Bridge auth token. Must match `DASHBOARD_TOKEN` in the repo-root .env
 * (default there is `admin` -- see core/config.js / .env.example).
 */
export const BRIDGE_TOKEN: string =
  process.env.NEXT_PUBLIC_BRIDGE_TOKEN || 'admin';

/**
 * Build a full bridge URL for `path`, appending `token` (and any
 * `extraParams`) as query parameters. Safe to call with a path that already
 * carries its own query string (e.g. "/api/x?serial=abc") -- those params
 * are preserved and merged with the token and any extraParams.
 */
export function bridgeUrl(
  path: string,
  extraParams?: Record<string, string | number | boolean | undefined | null>
): string {
  const base = BRIDGE_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryIndex = normalizedPath.indexOf('?');
  const pathname = queryIndex === -1 ? normalizedPath : normalizedPath.slice(0, queryIndex);
  const existingQuery = queryIndex === -1 ? '' : normalizedPath.slice(queryIndex + 1);

  const params = new URLSearchParams(existingQuery);
  params.set('token', BRIDGE_TOKEN);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }

  return `${base}${pathname}?${params.toString()}`;
}

/** Parses a numeric port out of a URL, for display purposes only. */
function parseBridgePort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3141;
  }
}

/** Numeric port derived from BRIDGE_URL, used only for informational UI display. */
export const BRIDGE_PORT: number = parseBridgePort(BRIDGE_URL);
