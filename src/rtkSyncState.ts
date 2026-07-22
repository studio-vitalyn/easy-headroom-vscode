import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { rtkInstanceIdPath, rtkLastPushedIdPath } from './paths';

/**
 * Identifies this RTK install to the aggregator. Not hostname- or hostname+username-derived:
 * both collide in practice (shared hosts, shared host+user, or several VS Code workspaces on the
 * same machine that don't share a history.db). A random UUID, persisted once next to history.db,
 * is the only scheme with no real collision case in this codebase's own deployments.
 */
export async function getOrCreateInstanceId(): Promise<string> {
  const p = rtkInstanceIdPath();
  try {
    const existing = (await fs.readFile(p, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // fall through to creation
  }
  const id = crypto.randomUUID();
  await fs.writeFile(p, id, 'utf8');
  return id;
}

export async function readLastPushedId(): Promise<number> {
  try {
    const raw = (await fs.readFile(rtkLastPushedIdPath(), 'utf8')).trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function writeLastPushedId(id: number): Promise<void> {
  await fs.writeFile(rtkLastPushedIdPath(), String(id), 'utf8');
}
