# Changelog

All notable changes to the easy-headroom extension are documented here.

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
