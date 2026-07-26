import * as fs from 'fs/promises';
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
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
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
