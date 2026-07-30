# Changelog

All notable changes to the easy-headroom extension are documented here.

## 0.3.0

### Added
- **TokenSave** integration: installs the [tokensave](https://github.com/aovestdipaperino/tokensave) binary, registers it as an MCP server for Claude Code, and indexes every open workspace folder, so its own token savings can be measured alongside RTK and Headroom's. A third, independent layer — enabled by default (`easy-headroom.tokensave.enabled`), with its own `pinnedVersion` setting and `easy-headroom: Select TokenSave Version` command. In unpinned mode, checks for a newer release once every 24h and upgrades in place, same as Headroom's own version check.
- `easy-headroom` output channel (`View → Output → easy-headroom`) logging RTK/Headroom/TokenSave setup outcomes on activation, so a missed notification isn't the only record of a setup failure.
- Status bar tooltip now shows each layer's installed version — RTK, Headroom (local venv version, or the *remote* instance's own reported version when `mode = remote`), and TokenSave — so a stale or forgotten remote config is visible at a glance instead of only inferable from a generic warning.
- Hourly background re-check (`UpdateCheckTimer`) that keeps TokenSave and Headroom actually current in a long-lived window — previously their own 24h upgrade check was only ever triggered once, at activation, so a window left open for days could silently sit on a stale binary.
- New **Settings** dashboard tab: a simplified, per-setting scope picker (User/Workspace/WorkspaceFolder, with a Remote-SSH-aware "User (Remote)" label) on top of the same real `contributes.configuration` values, so switching modes or pinning a version no longer requires the native Settings UI. Always reachable, even with every other layer disabled — writing at a broader scope while a narrower one already holds an override now asks for confirmation before clearing it, since that override may be a colleague's deliberate choice in a shared workspace, not a leftover.

### Fixed
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
