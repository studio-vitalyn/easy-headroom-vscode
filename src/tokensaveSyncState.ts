import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { tokensaveInstanceIdPath, tokensaveLastPushedIdPath } from './paths';

export async function getOrCreateInstanceId(): Promise<string> {
  const p = tokensaveInstanceIdPath();
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
    const raw = (await fs.readFile(tokensaveLastPushedIdPath(), 'utf8')).trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function writeLastPushedId(id: number): Promise<void> {
  await fs.writeFile(tokensaveLastPushedIdPath(), String(id), 'utf8');
}
