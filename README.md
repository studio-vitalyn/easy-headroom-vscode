# easyHeadroom

![easyHeadroom](https://raw.githubusercontent.com/studio-vitalyn/easy-headroom-vscode/main/assets/splash.png)

Stop hand-rolling your `rtk init`, Headroom proxy, and
`tokensave init` setup.
**easyHeadroom** is a VS Code extension that installs and configures
[RTK](https://github.com/rtk-ai/rtk),
[Headroom](https://github.com/headroomlabs-ai/headroom), and
[TokenSave](https://github.com/aovestdipaperino/tokensave) for you, so
your CLI coding agent burns far fewer tokens on every shell command,
API call, and codebase-exploration query.

## What it does

- **Installs RTK, Headroom, and/or TokenSave** automatically — no
  manual binary download, no PATH wrangling.
- **RTK works across agents** — Claude Code, Gemini CLI, and Codex
  CLI, pick which ones via `easy-headroom.rtk.agents`. Headroom (the
  API proxy) is Claude-Code-only, since it works by pointing
  `ANTHROPIC_BASE_URL` at itself. TokenSave registers itself as an MCP
  server and indexes every open workspace folder, so code-graph
  lookups replace token-hungry grep/Explore-agent searches.
- **Wires up the hooks** (`rtk init --global --auto-patch`) safely — won't
  re-patch your config on every restart — and points Claude Code at the
  Headroom proxy per project, whether you use the Claude Code VS Code
  extension or the standalone `claude` CLI.
- **Works on one host or several.** Use it standalone on your laptop, or
  point it at a centralized Headroom instance to aggregate RTK savings
  across every host — see [`easy-headroom-docker`](https://github.com/studio-vitalyn/easy-headroom-docker)
  below for a ready-made way to deploy that instance.
- **One click to your dashboard**, right from the status bar —
  including a CO₂ tab estimating the carbon footprint avoided by your
  savings.
- **Stays out of your way.** Don't want Headroom? Enable RTK only —
  zero network config touched.

## The status bar shield — click it 👉 🛡️

Everything this extension shows you lives behind **one button**: the
🛡️ shield in the status bar, bottom right of the window.

- When VS Code starts, it briefly announces itself as an animated
  **easy-headroom** label on an orange background, then settles down to
  the shield alone.
- **Click it** to open your dashboard: Headroom, RTK, TokenSave and CO₂
  tabs, plus a **Settings** tab where every option below can be changed
  without leaving the panel.
- **Hover it** for a summary: which of the three layers are enabled,
  the version of each, and the total tokens saved.
- **Green shield** = everything is running. **Red shield** = something
  needs you (a failed setup step, an unreachable proxy, a missing
  `remoteUrl`) — the tooltip says which layer, and a misconfigured
  Headroom opens straight onto the Settings tab so you can fix it
  there.

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
   - `easy-headroom.tokensave.enabled` — code-graph MCP server for
     token-efficient code research (on by default).
3. If you enable Headroom, choose a mode:
   - **local** — the extension runs the proxy for you, right on your
     machine. Nothing else to set up.
   - **remote** — already have a centralized Headroom instance running?
     Just point `remoteUrl` at it.
4. Click the 🛡️ shield in the status bar any time to jump to your
   savings dashboard — see above.

## Running Headroom on multiple hosts?

See [`easy-headroom-docker`](https://github.com/studio-vitalyn/easy-headroom-docker) —
a logically separate project that self-hosts Headroom plus a small
aggregation service, so RTK savings from every host roll up into one
shared dashboard.

## Why this exists

I was tired of installing and wiring up RTK, Headroom, and TokenSave by
hand on every project, and on every container/host I worked on — `rtk
init --global`, Headroom proxy and env vars, `tokensave init`, PATH
management, repeated every single time. All three are
excellent, independent tools, but none ships a one-click setup, and
none is designed for a Headroom instance shared across multiple
machines. This extension automates the former and enables the latter,
so I stop doing this by hand.

## Sponsor

If this project is useful to you, consider [sponsoring on GitHub](https://github.com/sponsors/jaysee).

## License

AGPL-3.0-or-later — see LICENSE.
