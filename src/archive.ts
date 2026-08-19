import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/** Shared by every tool that ships a per-platform release archive (RTK, tokensave). */

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function download(url: string, destFile: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destFile, buf);
}

export async function extractZipWindows(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      // Without this, every extraction flashes a console window on the user's desktop.
      { windowsHide: true }
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`))));
  });
}

export async function findBinaryRecursive(dir: string, binaryName: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findBinaryRecursive(full, binaryName);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return full;
    }
  }
  return undefined;
}

/**
 * Resolve a binary from the host's own PATH, deliberately ignoring anything under `excludeDir`
 * (the extension's own globalStorage) so a copy we installed ourselves never counts as "already
 * present on the machine". Pass the bare name (`rtk`, `tokensave`) — Windows extensions come from
 * PATHEXT here, POSIX only accepts an executable bit.
 *
 * Used by `ensureRtkInstalled`/`ensureTokensaveInstalled` to prefer a system install over
 * downloading a second copy — two competing installs of the same tool sharing one on-disk state
 * (a `.tokensave/tokensave.db`, an MCP registration) is a real, observed failure mode, not a
 * theoretical one.
 */
export async function findOnPath(binaryName: string, excludeDir?: string): Promise<string | undefined> {
  const raw = process.env.PATH;
  if (!raw) return undefined;

  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const excluded = excludeDir ? path.resolve(excludeDir) + path.sep : undefined;

  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    if (excluded && (resolvedDir + path.sep).startsWith(excluded)) continue;
    for (const ext of exts) {
      const candidate = path.join(resolvedDir, binaryName + ext);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // next candidate
      }
    }
  }
  return undefined;
}
