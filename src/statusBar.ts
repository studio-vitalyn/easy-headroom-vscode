import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { config } from './config';
import { checkHealth } from './daemon';
import { RtkInitFailure } from './rtk';

const SPARKLINE_CHARS = '▁▂▃▄▅▆▇█';
const POLL_INTERVAL_MS = 30_000;

type DaemonState = 'ok' | 'not-initialized' | 'error';

/**
 * Schema of `rtk gain --format json` isn't pinned down yet (see CLAUDE.md open questions) — this
 * reads defensively and degrades to a state-only status bar if the fields it expects aren't there.
 */
interface RtkGainSummary {
  totalSaved?: number;
  history?: number[];
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
      const child = spawn(rtkBinPath, ['gain', '--format', 'json']);
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

export class HeadroomStatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly rtkBinPath: string | undefined,
    private readonly rtkFailures: RtkInitFailure[] = []
  ) {
    this.item = vscode.window.createStatusBarItem('easy-headroom.status', vscode.StatusBarAlignment.Right, 100);
  }

  /** True when the extension can't function as configured and needs user action, not just a transient blip. */
  private isBroken(state: DaemonState): boolean {
    return state === 'error' || state === 'not-initialized' || this.rtkFailures.length > 0;
  }

  async refresh(): Promise<void> {
    const state = await this.computeState();
    const gain = await readRtkGain(this.rtkBinPath);
    const broken = this.isBroken(state);

    this.item.text = this.renderText(state, gain);
    this.item.tooltip = this.renderTooltip(state, gain);
    // errorBackground/warningBackground are the only two VS Code supports for status bar items —
    // any other ThemeColor here is silently ignored. Broken here covers RTK init failures and
    // Headroom misconfiguration/unreachability independently (see CLAUDE.md's "two independent
    // layers" principle) but only one button exists, so both feed the same visual signal.
    this.item.backgroundColor = broken ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.command = 'easy-headroom.statusBarMenu';
    this.item.show();
  }

  private renderText(state: DaemonState, gain?: RtkGainSummary): string {
    const icon = this.isBroken(state) ? '$(error)' : '$(check)';
    const parts = [icon, '$(zap) easy-headroom'];
    if (gain?.totalSaved !== undefined) {
      parts.push(`${gain.totalSaved.toLocaleString()} saved`);
    }
    if (gain?.history?.length) {
      parts.push(sparkline(gain.history));
    }
    return parts.join(' ');
  }

  private renderTooltip(state: DaemonState, gain?: RtkGainSummary): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**easy-headroom**\n\n`);

    md.appendMarkdown(`RTK: ${config.rtkEnabled() ? 'enabled' : 'disabled'}`);
    if (this.rtkFailures.length > 0) {
      const list = this.rtkFailures.map((f) => `${f.agent} (${f.error.message})`).join(', ');
      md.appendMarkdown(` — ⚠️ setup failed for: ${list}`);
    }
    md.appendMarkdown(`\n\n`);

    md.appendMarkdown(`Headroom: ${config.headroomEnabled() ? `enabled (${config.headroomMode()})` : 'disabled'}`);
    if (config.headroomEnabled()) {
      if (state === 'not-initialized') {
        md.appendMarkdown(
          config.headroomMode() === 'remote' ? ' — ⚠️ headroom.remoteUrl is not set' : ' — ⚠️ misconfigured'
        );
      } else if (state === 'error') {
        md.appendMarkdown(' — ⚠️ proxy unreachable');
      }
    }
    md.appendMarkdown(`\n\n`);

    if (gain?.totalSaved !== undefined) {
      md.appendMarkdown(`Total saved: ${gain.totalSaved.toLocaleString()}\n\n`);
    }
    md.appendMarkdown(`Click for options (dashboard, settings).`);
    return md;
  }

  private async computeState(): Promise<DaemonState> {
    if (!config.headroomEnabled()) return 'ok';
    const base = config.headroomMode() === 'local'
      ? `http://127.0.0.1:${config.headroomLocalPort()}`
      : config.headroomRemoteUrl();
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
