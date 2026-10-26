import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { config } from './config';
import { checkHealth, fetchRemoteHeadroomVersion } from './daemon';
import { RtkInitFailure } from './rtk';
import { TokensaveIndexFailure, getInstalledTokensaveVersion, runCapture } from './tokensave';
import { getInstalledHeadroomVersion } from './headroom';
import { knownUpdate } from './systemUpdates';
import { log } from './log';

const POLL_INTERVAL_MS = 30_000;
const STATS_TIMEOUT_MS = 2_000;
// The dollar total moves slowly and costs two spawns plus a request to read, so it's re-read on its
// own, slower cadence; health and versions keep the 30s poll.
const USD_REFRESH_MS = 5 * 60_000;

// RTK records saved tokens but no dollar figure. Priced at the same rate TokenSave's own `usd`
// uses ("USD saved (Sonnet input)" in `tokensave gain`, i.e. $3/MTok — checked: 798,016 tokens →
// $2.39): what RTK trims is shell output the model would otherwise have read as input, so it's the
// same kind of token, and one convention across both keeps the two figures comparable.
const RTK_USD_PER_TOKEN = 3 / 1_000_000;

const ACTIVATION_LABEL = 'easy-headroom';
const ACTIVATION_FRAME_MS = 120;
// Setup is often fully cached and finishes in a few hundred ms — without a floor, the one moment
// the extension gets to be noticed would be a flicker.
const ACTIVATION_MIN_VISIBLE_MS = 3_000;

/**
 * Temporary status bar item, shown from the first line of `activate()` until setup finishes: the
 * steady-state item is a bare `$(shield)` that's very easy to never notice, so activation is the
 * one moment where the extension names itself and points at its own button. The name is spelled
 * out next to the icon with a single letter capitalized at a time, running left to right on an
 * orange (warning) background — motion is what actually catches an eye in a crowded status bar.
 * Replaced by `HeadroomStatusBar` once setup is done, which then stays quiet for good.
 */
export class ActivationIndicator {
  private readonly item: vscode.StatusBarItem;
  private readonly shownAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem('easy-headroom.activation', vscode.StatusBarAlignment.Right, 100);
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    this.item.tooltip = 'easy-headroom is setting up RTK, Headroom and TokenSave — click this item any time to open your savings dashboard.';
    this.item.command = 'easy-headroom.openDashboard';
  }

  start(): void {
    this.render();
    this.item.show();
    this.timer = setInterval(() => this.render(), ACTIVATION_FRAME_MS);
  }

  private render(): void {
    const lit = this.frame++ % ACTIVATION_LABEL.length;
    const label = [...ACTIVATION_LABEL].map((c, i) => (i === lit ? c.toUpperCase() : c)).join('');
    this.item.text = `$(shield) ${label}`;
  }

  /** Resolves once the animation has been up long enough to be seen, then removes the item. */
  async finish(): Promise<void> {
    const remaining = ACTIVATION_MIN_VISIBLE_MS - (Date.now() - this.shownAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.dispose();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.item.dispose();
  }
}

type DaemonState = 'ok' | 'not-initialized' | 'error';

/**
 * `rtk gain --format json` prints `{ summary: { total_saved, ... } }` (confirmed against rtk
 * 0.45.0) — read defensively, a missing field just drops RTK out of the dollar total.
 */
interface RtkGainSummary {
  summary?: { total_saved?: number };
}

/** Per-source dollar savings; a source is undefined when it's disabled or couldn't be read. */
interface UsdSaved {
  headroom?: number;
  rtk?: number;
  tokensave?: number;
}

// Marker/tag-sourced versions (TokenSave's GitHub release tag, e.g. "v7.8.1") may already carry a
// leading "v" — normalized here so every tooltip line can safely format its own "v${version}".
function stripV(version: string | undefined): string | undefined {
  return version?.replace(/^v/i, '');
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 });
}

function totalUsd(usd: UsdSaved): number | undefined {
  const values = [usd.headroom, usd.rtk, usd.tokensave].filter((v): v is number => v !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Headroom's lifetime `summary.cost.total_saved_usd` off `/stats` — the same field the dashboard's
 * Headroom tab shows. In remote mode that's the shared instance's total, across every machine
 * reporting to it, since that's the only figure the proxy keeps.
 */
async function readHeadroomUsd(): Promise<number | undefined> {
  if (!config.headroomEnabled()) return undefined;
  const base = config.mode() === 'local' ? `http://127.0.0.1:${config.headroomLocalPort()}` : config.remoteUrl();
  if (!base) return undefined;
  const headers: Record<string, string> = {};
  const proxyToken = config.proxyToken();
  if (config.mode() === 'remote' && proxyToken) headers['X-Headroom-Proxy-Token'] = proxyToken;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/stats`, { headers, signal: AbortSignal.timeout(STATS_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { summary?: { cost?: { total_saved_usd?: unknown } } };
    const usd = body.summary?.cost?.total_saved_usd;
    return typeof usd === 'number' ? usd : undefined;
  } catch {
    return undefined;
  }
}

/** All projects, all time — the machine-wide ledger, matching RTK's own machine-wide history.db. */
async function readTokensaveUsd(tokensaveBinPath: string | undefined): Promise<number | undefined> {
  if (!tokensaveBinPath || !config.tokensaveEnabled()) return undefined;
  try {
    const { stdout } = await runCapture(tokensaveBinPath, ['gain', '--json', '--all', '--range', 'all']);
    const usd = (JSON.parse(stdout) as { usd?: unknown }).usd;
    return typeof usd === 'number' ? usd : undefined;
  } catch {
    return undefined;
  }
}

async function readRtkGain(rtkBinPath: string | undefined): Promise<RtkGainSummary | undefined> {
  if (!rtkBinPath) return undefined;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(rtkBinPath, ['gain', '--format', 'json'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`rtk gain exited ${code}`))));
    });
    return JSON.parse(output) as RtkGainSummary;
  } catch {
    return undefined;
  }
}

/**
 * RTK has no version-marker file (unlike Headroom/TokenSave — see "RTK install" in CLAUDE.md,
 * it always re-resolves "latest" on every activation), so the tooltip reads it straight off the
 * binary instead: `rtk --version` prints `rtk <semver>` (confirmed empirically).
 */
async function readRtkVersion(rtkBinPath: string | undefined): Promise<string | undefined> {
  if (!rtkBinPath) {
    log('RTK version not shown in tooltip — no rtkBinPath (RTK binary install never completed for this window)');
    return undefined;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(rtkBinPath, ['--version'], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out) : reject(new Error(`rtk --version exited ${code}: ${err.trim() || out.trim()}`))
      );
    });
    const version = output.trim().match(/(\d+\.\d+\.\d+\S*)/)?.[1];
    if (!version) {
      log(`RTK version not shown in tooltip — could not parse a version out of 'rtk --version' output: ${output.trim()}`);
    }
    return version;
  } catch (err) {
    log(`RTK version not shown in tooltip — ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Appended next to a tool's version when the copy in use is one the user installed themselves and a
 * newer release exists. Only ever a hint: the extension doesn't upgrade a binary it doesn't own
 * (see systemUpdates.ts), so the tooltip is where that fact stays visible after the one-shot
 * notification has been dismissed.
 */
function updateSuffix(tool: 'rtk' | 'tokensave'): string {
  const update = knownUpdate(tool);
  return update ? ` — ⬆️ v${update.latest} available` : '';
}

export class HeadroomStatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly rtkBinPath: string | undefined,
    private readonly rtkFailures: RtkInitFailure[] = [],
    private readonly version: string = '',
    private readonly tokensaveFailures: TokensaveIndexFailure[] = [],
    private readonly tokensaveBinPath: string | undefined = undefined
  ) {
    this.item = vscode.window.createStatusBarItem('easy-headroom.status', vscode.StatusBarAlignment.Right, 100);
  }

  private usd: UsdSaved = {};
  private usdReadAt = 0;

  private async readUsd(): Promise<UsdSaved> {
    if (Date.now() - this.usdReadAt < USD_REFRESH_MS) return this.usd;
    const [gain, headroom, tokensave] = await Promise.all([
      readRtkGain(this.rtkBinPath),
      readHeadroomUsd(),
      readTokensaveUsd(this.tokensaveBinPath),
    ]);
    const rtkSaved = gain?.summary?.total_saved;
    this.usd = { headroom, rtk: typeof rtkSaved === 'number' ? rtkSaved * RTK_USD_PER_TOKEN : undefined, tokensave };
    this.usdReadAt = Date.now();
    return this.usd;
  }

  /** True when the extension can't function as configured and needs user action, not just a transient blip. */
  private isBroken(state: DaemonState): boolean {
    return (
      state === 'error' ||
      state === 'not-initialized' ||
      this.rtkFailures.length > 0 ||
      this.tokensaveFailures.length > 0
    );
  }

  async refresh(): Promise<void> {
    const state = await this.computeState();
    const remoteUrl = config.remoteUrl();
    const [usd, rtkVersion, headroomVersion, tokensaveVersion, headroomRemoteVersion] = await Promise.all([
      this.readUsd(),
      readRtkVersion(this.rtkBinPath),
      getInstalledHeadroomVersion(this.context),
      this.tokensaveBinPath ? getInstalledTokensaveVersion(this.context, this.tokensaveBinPath) : Promise.resolve(undefined),
      config.headroomEnabled() && config.mode() === 'remote' && remoteUrl
        ? fetchRemoteHeadroomVersion(remoteUrl)
        : Promise.resolve(undefined),
    ]);
    const broken = this.isBroken(state);
    this.item.text = this.renderText(usd);
    this.item.tooltip = this.renderTooltip(state, usd, {
      rtkVersion,
      headroomVersion,
      tokensaveVersion,
      headroomRemoteVersion,
    });
    // Single brand icon, recolored rather than swapped — covers RTK init failures, TokenSave
    // indexing failures, and Headroom misconfiguration/unreachability independently (see
    // CLAUDE.md's "two independent layers" principle) but only one button exists, so all three
    // feed the same visual signal. Background is restricted by VS Code to exactly these two
    // ThemeColors (anything else is silently ignored) — errorBackground/errorForeground give a
    // red pill + white icon that's actually visible, unlike a bare recolored icon on the default
    // status bar background.
    this.item.backgroundColor = broken ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.color = broken
      ? new vscode.ThemeColor('statusBarItem.errorForeground')
      : new vscode.ThemeColor('charts.green');
    this.item.command = 'easy-headroom.openDashboard';
    this.item.show();
  }

  private renderText(usd: UsdSaved): string {
    // $(shield) stands in for assets/easy-headroom-ico.svg — VS Code status bar items only
    // render Codicons/contributed icon-fonts in `text`, not arbitrary SVGs, and no icon-font
    // build pipeline exists for this extension yet.
    const total = totalUsd(usd);
    return total === undefined ? '$(shield)' : `$(shield) ${fmtUsd(total)}`;
  }

  private renderTooltip(
    state: DaemonState,
    usd: UsdSaved,
    versions?: {
      rtkVersion?: string;
      headroomVersion?: string;
      tokensaveVersion?: string;
      headroomRemoteVersion?: string;
    }
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**easyHeadroom**${this.version ? ` v${this.version}` : ''}\n\n`);

    md.appendMarkdown(`RTK: ${config.rtkEnabled() ? 'enabled' : 'disabled'}`);
    const rtkVersion = stripV(versions?.rtkVersion);
    if (config.rtkEnabled()) {
      // Always show *something* here rather than silently omitting it — "(version unknown)"
      // points at the Output channel instead of leaving an unexplained gap next to "enabled".
      md.appendMarkdown(rtkVersion ? ` (v${rtkVersion})` : ' (version unknown — see "easy-headroom" output log)');
      md.appendMarkdown(updateSuffix('rtk'));
    }
    if (this.rtkFailures.length > 0) {
      const list = this.rtkFailures.map((f) => `${f.agent} (${f.error.message})`).join(', ');
      md.appendMarkdown(` — ⚠️ setup failed for: ${list}`);
    }
    md.appendMarkdown(`\n\n`);

    md.appendMarkdown(`Mode: ${config.mode()}\n\n`);
    md.appendMarkdown(`Headroom: ${config.headroomEnabled() ? 'enabled' : 'disabled'}`);
    if (config.headroomEnabled()) {
      // Local/remote called out explicitly here (rather than just relying on "Mode" above), each
      // showing *its own* running version rather than a URL — so a remote that's been forgotten
      // (no reachable version) or silently drifted from the local one is obvious at a glance.
      if (config.mode() === 'local') {
        const localVersion = stripV(versions?.headroomVersion);
        md.appendMarkdown(localVersion ? ` — local v${localVersion}` : ' — local');
      } else {
        const remoteVersion = stripV(versions?.headroomRemoteVersion);
        if (!config.remoteUrl()) {
          md.appendMarkdown(' — remote (not set)');
        } else {
          md.appendMarkdown(remoteVersion ? ` — remote v${remoteVersion}` : ' — remote (unreachable)');
        }
      }
      if (state === 'not-initialized') {
        md.appendMarkdown(
          config.mode() === 'remote' ? ' — ⚠️ remoteUrl is not set' : ' — ⚠️ misconfigured'
        );
      } else if (state === 'error') {
        md.appendMarkdown(' — ⚠️ proxy unreachable');
      }
    }
    md.appendMarkdown(`\n\n`);

    md.appendMarkdown(`TokenSave: ${config.tokensaveEnabled() ? 'enabled' : 'disabled'}`);
    const tokensaveVersion = stripV(versions?.tokensaveVersion);
    if (config.tokensaveEnabled() && tokensaveVersion) {
      md.appendMarkdown(` (v${tokensaveVersion})`);
    }
    if (config.tokensaveEnabled()) {
      md.appendMarkdown(updateSuffix('tokensave'));
    }
    if (this.tokensaveFailures.length > 0) {
      const list = this.tokensaveFailures.map((f) => `${f.folder} (${f.error.message})`).join(', ');
      md.appendMarkdown(` — ⚠️ indexing failed for: ${list}`);
    }
    md.appendMarkdown(`\n\n`);

    const total = totalUsd(usd);
    if (total !== undefined) {
      const breakdown = [
        usd.headroom !== undefined ? `Headroom ${fmtUsd(usd.headroom)}` : undefined,
        usd.rtk !== undefined ? `RTK ~${fmtUsd(usd.rtk)}` : undefined,
        usd.tokensave !== undefined ? `TokenSave ${fmtUsd(usd.tokensave)}` : undefined,
      ].filter(Boolean);
      md.appendMarkdown(`Total saved: **${fmtUsd(total)}** (${breakdown.join(' · ')})\n\n`);
      if (usd.rtk !== undefined) {
        md.appendMarkdown(`_RTK keeps no dollar figure — its tokens are priced at TokenSave's rate ($3 per million input tokens)._\n\n`);
      }
    }
    md.appendMarkdown(`Click to open the dashboard.`);
    return md;
  }

  private async computeState(): Promise<DaemonState> {
    if (!config.headroomEnabled()) return 'ok';
    const base = config.mode() === 'local'
      ? `http://127.0.0.1:${config.headroomLocalPort()}`
      : config.remoteUrl();
    if (!base) return 'not-initialized';
    const healthy = await checkHealth(base);
    return healthy ? 'ok' : 'error';
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
