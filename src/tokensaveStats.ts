import { runCapture } from './tokensave';
import { config } from './config';

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

interface TokensaveRemoteSeries {
  calls: number;
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  savings_pct: number;
}

export type TokensaveRemoteDaily = TokensaveRemoteSeries & { date: string };
export type TokensaveRemoteWeekly = TokensaveRemoteSeries & { week_start: string; week_end: string };
export type TokensaveRemoteMonthly = TokensaveRemoteSeries & { month: string };

export interface TokensaveRemoteStats {
  summary: TokensaveRemoteSeries;
  daily: TokensaveRemoteDaily[];
  weekly: TokensaveRemoteWeekly[];
  monthly: TokensaveRemoteMonthly[];
}

export interface TokensaveProjectSummary {
  id_project: string;
  label: string;
  calls: number;
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  avg_savings_pct: number;
}

/**
 * Same principle as rtkStats.ts's `fetchJson` — attaches the shared proxy token, treats any
 * failure (network, non-2xx, malformed body) as "no data" rather than throwing.
 */
async function fetchJson<T>(url: string): Promise<T | undefined> {
  const headers: Record<string, string> = {};
  const proxyToken = config.proxyToken();
  if (proxyToken) headers['X-Headroom-Proxy-Token'] = proxyToken;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export async function getRemoteTokensaveStats(project?: string): Promise<TokensaveRemoteStats | undefined> {
  const base = config.tokensaveAggregateEndpoint();
  if (!base) return undefined;
  const url = project ? `${base}?project=${encodeURIComponent(project)}` : base;
  return fetchJson<TokensaveRemoteStats>(url);
}

export async function getRemoteTokensaveProjects(): Promise<TokensaveProjectSummary[]> {
  const base = config.tokensaveProjectsEndpoint();
  if (!base) return [];
  const body = await fetchJson<{
    projects: Omit<TokensaveProjectSummary, 'label'>[];
  }>(base);
  if (!body) return [];
  return body.projects.map((p) => ({ ...p, label: p.id_project }));
}

/** TokenSave's remote/aggregator mode, mirroring RTK's `useRemote()` in rtkStats.ts. */
export function tokensaveUseRemote(): boolean {
  return Boolean(config.tokensaveAggregateEndpoint());
}
