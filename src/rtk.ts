import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import * as tar from 'tar';
import { config } from './config';
import { storagePaths } from './paths';
import { AgentId, isRtkIntegrated, rtkInitArgs } from './rtkAgents';

const REPO = 'rtk-ai/rtk';

function assetName(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'rtk-aarch64-apple-darwin.tar.gz' : 'rtk-x86_64-apple-darwin.tar.gz';
  }
  if (platform === 'win32') {
    return 'rtk-x86_64-pc-windows-msvc.zip';
  }
  // linux
  return arch === 'arm64' ? 'rtk-aarch64-unknown-linux-gnu.tar.gz' : 'rtk-x86_64-unknown-linux-musl.tar.gz';
}

function downloadUrl(asset: string, pinnedVersion: string): string {
  return pinnedVersion
    ? `https://github.com/${REPO}/releases/download/${pinnedVersion}/${asset}`
    : `https://github.com/${REPO}/releases/latest/download/${asset}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, destFile: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destFile, buf);
}

async function extractZipWindows(zipPath: string, destDir: string): Promise<void> {
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

async function findBinaryRecursive(dir: string, binaryName: string): Promise<string | undefined> {
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

export async function ensureRtkInstalled(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (!config.rtkEnabled()) return undefined;

  const paths = storagePaths(context);
  if (await pathExists(paths.rtkBinPath)) {
    return paths.rtkBinPath;
  }

  await fs.mkdir(paths.rtkBinDir, { recursive: true });
  const asset = assetName();
  const url = downloadUrl(asset, config.rtkPinnedVersion());
  const tmpFile = path.join(os.tmpdir(), `easy-headroom-rtk-${Date.now()}-${asset}`);

  try {
    await download(url, tmpFile);

    if (asset.endsWith('.tar.gz')) {
      await tar.extract({ file: tmpFile, cwd: paths.rtkBinDir });
    } else {
      await extractZipWindows(tmpFile, paths.rtkBinDir);
    }

    const binaryName = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
    const found = await findBinaryRecursive(paths.rtkBinDir, binaryName);
    if (!found) {
      throw new Error(`Could not locate '${binaryName}' inside extracted RTK archive`);
    }
    if (found !== paths.rtkBinPath) {
      await fs.rename(found, paths.rtkBinPath);
    }
    if (process.platform !== 'win32') {
      await fs.chmod(paths.rtkBinPath, 0o755);
    }
  } finally {
    await fs.rm(tmpFile, { force: true });
  }

  return paths.rtkBinPath;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${args.join(' ')} exited ${code}`))));
  });
}

export interface RtkInitFailure {
  agent: AgentId;
  error: Error;
}

/**
 * Idempotent per agent (checked via isRtkIntegrated before re-running). Each configured agent is set
 * up independently and a failure on one doesn't block the others — see the "two strictly independent
 * layers" principle in CLAUDE.md, applied here across agents rather than across RTK/Headroom.
 *
 * Note: `rtk init --gemini`/`--codex` don't check whether that agent's CLI is actually installed —
 * they unconditionally write that agent's config files regardless. So `failures` here reflects real
 * errors (rtk binary missing/broken, permission issues), not "agent not present on this machine".
 */
export async function ensureRtkInitialized(rtkBinPath: string): Promise<RtkInitFailure[]> {
  const failures: RtkInitFailure[] = [];
  for (const agent of config.rtkAgents()) {
    if (await isRtkIntegrated(agent)) continue;
    try {
      await run(rtkBinPath, rtkInitArgs(agent));
    } catch (err) {
      failures.push({ agent, error: err as Error });
    }
  }
  return failures;
}
