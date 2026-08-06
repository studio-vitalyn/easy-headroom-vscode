# Changelog

All notable changes to the easy-headroom extension are documented here.

## 0.5.0

### Added
- **The status bar item now announces itself on startup.** While the extension sets up, a temporary orange item spells out `easy-headroom` next to the shield with a letter capitalized at a time, running left to right; it disappears once setup is done, leaving the usual quiet shield. The shield is the only entry point to the dashboard and was easy to miss entirely.
- README now documents the shield: what a click, a hover, and a green/red state each get you.

## 0.4.1

### Fixed
- **BUGFIX [#1](https://github.com/studio-vitalyn/easy-headroom-vscode/issues/1) — Windows: no more console windows popping up.** Every child process the extension spawns (`rtk gain`/`rtk --version` on the status bar's 30s poll, `rtk init`, `tokensave`, the Python/Headroom probes, PowerShell's `Expand-Archive`) now passes `windowsHide: true`, so nothing flashes a `cmd`/console window on the desktop anymore. The status bar poll made this recur every 30 seconds, which is why closing the window only brought it back.
- **Windows: the `py -3` Python launcher was never actually selected.** Its version probe spawned the literal string `"py -3"` as an executable, which always failed, so detection silently fell through to a bare `python` (possibly the Microsoft Store stub).

## 0.4.0

### Added
- **CO2** tab now also allocates **TokenSave**'s savings across models, alongside RTK's — as its own orange column, headline row and legend entry, never merged into Headroom's or RTK's figures. Like RTK's, this is a proxy on top of a proxy (TokenSave has no per-model attribution either, so Headroom's own per-model token mix is used as the distribution), spelled out in the tab's disclaimer. The tab-bar metric sums the three sources.

### Fixed
- RTK tab's "current project" filter matched the project path exactly, so nothing showed for commands run from a subdirectory of the workspace — now matches by path prefix.

## 0.3.0

### Added
- **TokenSave** integration: installs the [tokensave](https://github.com/aovestdipaperino/tokensave) binary, registers it as an MCP server for Claude Code, and indexes every open workspace folder, so its own token savings can be measured alongside RTK and Headroom's. A third, independent layer — enabled by default (`easy-headroom.tokensave.enabled`), with its own `pinnedVersion` setting and `easy-headroom: Select TokenSave Version` command. In unpinned mode, checks for a newer release once every 24h and upgrades in place, same as Headroom's own version check.
- `easy-headroom` output channel (`View → Output → easy-headroom`) logging RTK/Headroom/TokenSave setup outcomes on activation, so a missed notification isn't the only record of a setup failure.
- Status bar tooltip now shows each layer's installed version — RTK, Headroom (local venv version, or the *remote* instance's own reported version when `mode = remote`), and TokenSave — so a stale or forgotten remote config is visible at a glance instead of only inferable from a generic warning.
- Hourly background re-check (`UpdateCheckTimer`) that keeps TokenSave and Headroom actually current in a long-lived window — previously their own 24h upgrade check was only ever triggered once, at activation, so a window left open for days could silently sit on a stale binary.
- New **TokenSave** dashboard tab, alongside Headroom's, RTK's and CO2's: savings cards, a history chart with a range picker (`today`/`7d`/`30d`/`month`/`all`), and an index-health note (symbol/file counts, DB size, last sync) so a stale index is visible rather than silently under-reporting.
- TokenSave remote-mode reporting, mirroring RTK's: new savings rows are pushed incrementally to `/tokensave/ingest` with checkpoint reconciliation, and the TokenSave tab reads back from `/tokensave/aggregate` (project selector defaulting to the current project, fixed daily/weekly/monthly buckets) instead of only shelling out to the local CLI.
- New **Settings** dashboard tab: a simplified, per-setting scope picker (User/Workspace/WorkspaceFolder, with a Remote-SSH-aware "User (Remote)" label) on top of the same real `contributes.configuration` values, so switching modes or pinning a version no longer requires the native Settings UI. Always reachable, even with every other layer disabled — writing at a broader scope while a narrower one already holds an override now asks for confirmation before clearing it, since that override may be a colleague's deliberate choice in a shared workspace, not a leftover.

### Changed
- **Breaking setting rename**: `easy-headroom.headroom.mode`, `.headroom.remoteUrl` and `.headroom.proxyToken` moved up to `easy-headroom.mode`, `easy-headroom.remoteUrl` and `easy-headroom.proxyToken`. They describe the shared instance itself, not Headroom specifically — every layer (Headroom, RTK reporting, TokenSave) now reads them independently, so disabling Headroom no longer silently disables RTK's remote stats. Existing values under the old keys are not migrated automatically; re-set them from the Settings tab.
- Status bar click now opens the dashboard directly instead of a Dashboard/Settings quick pick (the `easy-headroom.statusBarMenu` command is gone) — the dashboard has its own Settings tab now.

### Fixed
- A misconfigured Headroom (enabled but with no resolvable target, e.g. remote mode without a `remoteUrl`) blocked the entire dashboard behind an error popup. It now opens on the Settings tab instead, so the misconfiguration can actually be fixed from there.
- Status bar's broken state (RTK/TokenSave setup failures, Headroom misconfigured or unreachable) now renders as a red pill (`statusBarItem.errorBackground` + `errorForeground`) instead of a barely-visible recolored icon.
- Status bar tooltip was missing TokenSave's enabled/disabled state and indexing-failure details entirely.

## 0.2.0

### Added
- New **CO2** dashboard tab estimating per-model carbon footprint from Headroom's persistent savings, using static per-model coefficients (`resources/carbon-coefficients.json`). RTK's model-agnostic savings are allocated across models as a secondary estimate. This is an estimate based on published coefficients, not a measured value.

### Changed
- Status bar now shows a single `$(shield)` icon recolored (green/red) based on state, instead of swapping between separate icons with a background color. The tooltip now also shows the installed extension version.

## 0.1.0

Initial public release. (c6757f5)

- Automatic setup of RTK (Rust Token Killer) and Headroom for a workspace.
- Local and remote Headroom proxy modes, with per-project environment wiring for both integrated terminals and Claude Code's own CLI.
- Dashboard webview with token/cost savings stats.
- Status bar indicator for proxy health.
