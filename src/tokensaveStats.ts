import * as vscode from 'vscode';
import { runCapture } from './tokensave';

export type TokensaveRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface TokensaveGain {
  range: string;
  project: string;
  saved_tokens: number;
  calls: number;
  usd: number;
}

export interface TokensaveHistoryPoint {
  day: number;
  saved_tokens: number;
  calls: number;
  usd: number;
}

export interface TokensaveStatus {
  node_count: number;
  edge_count: number;
  file_count: number;
  db_size_bytes: number;
  last_updated: number;
  last_sync_at: number;
  last_full_sync_at: number;
  files_by_language: Record<string, number>;
}

export interface TokensaveFolder {
  name: string;
  path: string;
}

export function getTokensaveFolders(): TokensaveFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

async function runJson<T>(tokensaveBinPath: string, args: string[], cwd: string): Promise<T | undefined> {
  try {
    const { stdout } = await runCapture(tokensaveBinPath, args, cwd);
    return JSON.parse(stdout) as T;
  } catch {
    // No index yet at this cwd, binary missing, or malformed output — treated the same as "no data".
    return undefined;
  }
}

export function getTokensaveGain(
  tokensaveBinPath: string,
  cwd: string,
  range: TokensaveRange
): Promise<TokensaveGain | undefined> {
  return runJson(tokensaveBinPath, ['gain', '--json', '--range', range], cwd);
}

export function getTokensaveHistory(
  tokensaveBinPath: string,
  cwd: string,
  range: TokensaveRange
): Promise<TokensaveHistoryPoint[] | undefined> {
  return runJson(tokensaveBinPath, ['gain', '--json', '--history', '--range', range], cwd);
}

export function getTokensaveStatus(tokensaveBinPath: string, cwd: string): Promise<TokensaveStatus | undefined> {
  return runJson(tokensaveBinPath, ['status', '--json'], cwd);
}
