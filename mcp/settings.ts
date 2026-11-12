// Persistent app settings: the AI agent switch and its token, and the preferred port.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './state';

export interface Settings {
  mcp: { enabled: boolean; token: string };
  /** Preferred port of the desktop app's local server (the agent's connection URL uses it). */
  port?: number;
}

const defaults = (): Settings => ({ mcp: { enabled: false, token: randomBytes(24).toString('hex') } });

let cache: Settings | undefined;
let cacheMtime = -1;

function file(): string | undefined {
  return config.stateDir ? path.join(config.stateDir, 'settings.json') : undefined;
}

export function getSettings(): Settings {
  const f = file();
  if (f && existsSync(f)) {
    const m = statSync(f).mtimeMs;
    if (!cache || m !== cacheMtime) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<Settings>;
        const d = defaults();
        cache = {
          mcp: { enabled: raw.mcp?.enabled === true, token: typeof raw.mcp?.token === 'string' && raw.mcp.token.length >= 16 ? raw.mcp.token : d.mcp.token },
          port: Number.isInteger(raw.port) ? raw.port : undefined,
        };
      } catch (e) {
        console.error(`[vblens-mcp] settings file unreadable, using defaults: ${(e as Error).message}`);
        cache = defaults();
      }
      cacheMtime = m;
    }
    return cache;
  }
  cache ??= defaults();
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  cache = next;
  const f = file();
  if (f) {
    try {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(next, null, 1), { mode: 0o600 });
      cacheMtime = statSync(f).mtimeMs;
    } catch (e) {
      console.error(`[vblens-mcp] could not save settings: ${(e as Error).message}`);
    }
  }
  return next;
}
