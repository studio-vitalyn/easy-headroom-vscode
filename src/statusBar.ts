import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { config } from './config';
import { checkHealth, fetchRemoteHeadroomVersion } from './daemon';
import { RtkInitFailure } from './rtk';
import { TokensaveIndexFailure, getInstalledTokensaveVersion } from './tokensave';
import { getInstalledHeadroomVersion } from './headroom';
import { log } from './log';

const SPARKLINE_CHARS = '▁▂▃▄▅▆▇█';
const POLL_INTERVAL_MS = 30_000;

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
 * Schema of `rtk gain --format json` isn't pinned down yet (see CLAUDE.md open questions) — this
 * reads defensively and degrades to a state-only status bar if the fields it expects aren't there.
 */
interface RtkGainSummary {
  totalSaved?: number;
  history?: number[];
}

// Marker/tag-sourced versions (TokenSave's GitHub release tag, e.g. "v7.8.1") may already carry a
// leading "v" — normalized here so every tooltip line can safely format its own "v${version}".
function stripV(version: string | undefined): string | undefined {
  return version?.replace(/^v/i, '');
}

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARKLINE_CHARS[Math.min(SPARKLINE_CHARS.length - 1, Math.floor((v / max) * (SPARKLINE_CHARS.length - 1)))])
    .join('');
}

async function readRtkGain(rtkBinPath: string | undefined): Promise<RtkGainSummary | undefined> {
  if (!rtkBinPath) return undefined;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(rtkBinPath, ['gain', '--format', 'json'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`rtk gain exited ${code}`))));
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
      child.on('exit', (code) =>
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
    const gain = await readRtkGain(this.rtkBinPath);
    const remoteUrl = config.remoteUrl();
    const [rtkVersion, headroomVersion, tokensaveVersion, headroomRemoteVersion] = await Promise.all([
      readRtkVersion(this.rtkBinPath),
      getInstalledHeadroomVersion(this.context),
      this.tokensaveBinPath ? getInstalledTokensaveVersion(this.context) : Promise.resolve(undefined),
      config.headroomEnabled() && config.mode() === 'remote' && remoteUrl
        ? fetchRemoteHeadroomVersion(remoteUrl)
        : Promise.resolve(undefined),
    ]);
    const broken = this.isBroken(state);

    this.item.text = this.renderText(gain);
    this.item.tooltip = this.renderTooltip(state, gain, {
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

  private renderText(gain?: RtkGainSummary): string {
    // $(shield) stands in for assets/easy-headroom-ico.svg — VS Code status bar items only
    // render Codicons/contributed icon-fonts in `text`, not arbitrary SVGs, and no icon-font
    // build pipeline exists for this extension yet.
    const parts = ['$(shield)'];
    if (gain?.totalSaved !== undefined) {
      parts.push(`${gain.totalSaved.toLocaleString()} saved`);
    }
    if (gain?.history?.length) {
      parts.push(sparkline(gain.history));
    }
    return parts.join(' ');
  }

  private renderTooltip(
    state: DaemonState,
    gain?: RtkGainSummary,
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
    if (this.tokensaveFailures.length > 0) {
      const list = this.tokensaveFailures.map((f) => `${f.folder} (${f.error.message})`).join(', ');
      md.appendMarkdown(` — ⚠️ indexing failed for: ${list}`);
    }
    md.appendMarkdown(`\n\n`);

    if (gain?.totalSaved !== undefined) {
      md.appendMarkdown(`Total saved: ${gain.totalSaved.toLocaleString()}\n\n`);
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
