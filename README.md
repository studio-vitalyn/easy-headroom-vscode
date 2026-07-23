# easyHeadroom

![easyHeadroom](https://raw.githubusercontent.com/studio-vitalyn/easy-headroom-vscode/main/assets/splash.png)

Stop hand-rolling your `rtk init` and `headroom wrap claude` setup.
**easyHeadroom** is a VS Code extension that installs and configures
[RTK](https://github.com/rtk-ai/rtk) and
[Headroom](https://github.com/headroomlabs-ai/headroom) for you, so
your CLI coding agent burns far fewer tokens on every shell command
and API call.

## What it does

- **Installs RTK and/or Headroom** automatically — no manual binary
  download, no PATH wrangling.
- **RTK works across agents** — Claude Code, Gemini CLI, and Codex
  CLI, pick which ones via `easy-headroom.rtk.agents`. Headroom (the
  API proxy) is Claude-Code-only, since it works by pointing
  `ANTHROPIC_BASE_URL` at itself.
- **Wires up the hooks** (`rtk init --global --auto-patch`, `headroom wrap claude`)
  safely — won't re-patch your config on every restart.
- **Works on one host or several.** Use it standalone on your laptop, or
  point it at a centralized Headroom instance to aggregate RTK savings
  across every host — see [`easy-headroom-docker`](https://github.com/studio-vitalyn/easy-headroom-docker)
  below for a ready-made way to deploy that instance.
- **One click to your dashboard**, right from the status bar —
  including a CO₂ tab estimating the carbon footprint avoided by your
  savings.
- **Stays out of your way.** Don't want Headroom? Enable RTK only —
  zero network config touched.

## Install

[![Install in VS Code](https://img.shields.io/badge/VS%20Code-Install-blue?logo=visualstudiocode)](vscode:extension/Vitalyn.easy-headroom)

Or search for **easy-headroom** in the VS Code Extensions view, or:

```bash
code --install-extension Vitalyn.easy-headroom
```

## Quick start

1. Install the extension.
2. Open the settings and pick what you want:
   - `easy-headroom.rtk.enabled` — shell output compression (on by
     default).
   - `easy-headroom.rtk.agents` — which agents RTK sets up
     (`claude` by default; add `gemini`/`codex` as needed).
   - `easy-headroom.headroom.enabled` — API compression, caching, and
     output shaping (Claude Code only).
3. If you enable Headroom, choose a mode:
   - **local** — the extension runs the proxy for you, right on your
     machine. Nothing else to set up.
   - **remote** — already have a centralized Headroom instance running?
     Just point `remoteUrl` at it.
4. Click the status bar item any time to jump to your savings
   dashboard.

## Running Headroom on multiple hosts?

See [`easy-headroom-docker`](https://github.com/studio-vitalyn/easy-headroom-docker) —
a logically separate project that self-hosts Headroom plus a small
aggregation service, so RTK savings from every host roll up into one
shared dashboard.

## Why this exists

I was tired of installing and wiring up RTK and Headroom by hand on
every project, and on every container/host I worked on — `rtk init
--global`, `headroom wrap claude`, PATH management, env vars, repeated
every single time. Both are excellent, independent tools, but
neither ships a one-click setup, and neither is designed for a Headroom
instance shared across multiple machines. This extension automates the
former and enables the latter, so I stop doing this by hand.

## Sponsor

If this project is useful to you, consider [sponsoring on GitHub](https://github.com/sponsors/jaysee).

## License

AGPL-3.0-or-later — see LICENSE.
