# easy-headroom

VS Code extension that installs, configures, and manages **RTK**,
**Headroom**, and **TokenSave** automatically, to reduce token
consumption for CLI coding agents.

## Multi-agent scope (V1)

RTK and Headroom are **not** symmetrical across agents, and the
extension must not pretend otherwise:

- **RTK** (shell-command rewrite) is agent-agnostic infrastructure —
  it hooks into the *agent's tool-call layer*, not any specific LLM
  API. V1 supports **Claude Code, Gemini CLI, and Codex CLI**, each
  configured and enabled independently via `easy-headroom.rtk.agents`
  (default `["claude"]`, so upgrading users keep today's behavior
  unless they opt in to more). Per
  [RTK's supported-agents docs](https://www.rtk-ai.app/docs/getting-started/supported-agents/):
  - **Claude Code**: full transparent `PreToolUse` shell hook.
    `rtk init --global --auto-patch`. Patches `~/.claude/settings.json`.
  - **Gemini CLI**: full transparent hook (Rust `BeforeTool`).
    `rtk init --global --gemini --auto-patch`. Patches
    `~/.gemini/settings.json` — **confirmed** via
    `rtk init --global --gemini --dry-run` against a real rtk 0.43.0
    install (also creates `~/.gemini/hooks/rtk-hook-gemini.sh` and
    `~/.gemini/GEMINI.md`).
  - **Codex CLI**: prompt-level only, **no interception** —
    `rtk init --global --codex` writes `~/.codex/AGENTS.md` +
    `~/.codex/RTK.md` (or under `$CODEX_HOME` if set — confirmed via
    `rtk init --help`). There is no reliable transparent-rewrite
    guarantee for Codex the way there is for Claude/Gemini; idempotency
    is checked as a plain substring match in AGENTS.md, and
    `uninstallCleanup` deliberately does **not** try to auto-strip the
    AGENTS.md block (no safe machine-parseable boundary in free-form
    markdown) — left for manual removal.
  - **`--auto-patch` is required for Claude/Gemini, forbidden for
    Codex.** Confirmed empirically: without it, `rtk init --global[
    --gemini]` prompts on stdin before patching settings.json — fatal
    since the extension spawns rtk with `stdio: 'ignore'` (no stdin to
    answer). `--codex` never touches a settings.json (plain file
    writes) and actively rejects `--auto-patch`
    (`--codex cannot be combined with --auto-patch`), so it's omitted
    for that agent. See `rtkInitArgs` in `rtkAgents.ts`.
  - **`rtk init` does not check whether the target agent's CLI is
    actually installed** — it unconditionally writes that agent's
    config files regardless (confirmed empirically). So a per-agent
    entry in `ensureRtkInitialized`'s failure list means a real error
    (rtk binary broken, permissions), not "agent absent from this
    machine" — there's no such check to rely on.
  - Each agent is initialized independently in a loop
    (`ensureRtkInitialized` in `rtk.ts`); one agent failing surfaces a
    warning but never blocks the others.
- **Headroom** (API compression proxy) stays **Claude-Code-only**.
  It works by pointing `ANTHROPIC_BASE_URL` at the local/remote proxy —
  an Anthropic-Messages-API-specific mechanism. Gemini CLI and Codex
  CLI talk to entirely different provider APIs, so there is nothing to
  generalize here without Headroom itself gaining multi-provider
  support (not confirmed, out of scope for V1). `headroom wrap claude`
  and all of `claudeSettings.ts` remain intentionally Claude-only.
- **TokenSave** (semantic code-graph MCP server) is **Claude-Code-only
  for V1** too — `tokensave install`/`uninstall --agent <id>` support
  many other agents upstream, but this extension only ever passes
  `--agent claude`, matching the single agent this rollout is actually
  being measured against. Not symmetrical with RTK's multi-agent
  `rtk.agents` setting — there's no `tokensave.agents` list — since
  broadening this is a deliberate future step, not an oversight.

A separate, optional project — **`docker-easy-headroom`** — provides a
Docker bundle to run Headroom on a centralized instance shared across
multiple machines/containers, aggregating RTK savings from all of them
onto one dashboard. It has a first working cut — see
`../docker/CLAUDE.md`. Logically a separate project, and physically a
separate GitHub repo (`studio-vitalyn/easy-headroom-docker`), consumed
here as a git submodule at `easy-headroom/docker/` — this extension
lives the same way, as `studio-vitalyn/easy-headroom-vscode` at
`easy-headroom/vscode/`. Both are submodules of the `easy-headroom`
parent repo, which is hosted on GitLab (not GitHub).

## Context / why this project exists

RTK (shell output compression, local `PreToolUse`-style hook) and
Headroom (API compression proxy + cache + output shaping) are two
complementary but independent tools, each with its own manual CLI
setup (`rtk init --global`, `headroom wrap claude`, PATH management,
env vars). Today there is:
- no official VS Code extension that automates this setup,
- no simple solution for a Headroom instance shared across multiple
  machines (both the official desktop app and the CLI target a
  "one dev, one machine" usage pattern).

This project fills both gaps: an extension that does the local setup
in one click, with an option to point at a shared, centralized
Headroom instance (provided by the separate `docker-easy-headroom`
project).

## Two separate projects

```
easy-headroom/
├── vscode/       → this project — the VS Code extension (main product)
└── docker/       → docker-easy-headroom (first working cut) — optional
                     Docker bundle to self-host Headroom + the RTK
                     aggregation service, for multi-host setups
```

A solo dev only needs `vscode/` (local mode, everything runs on their
machine). `docker-easy-headroom` is only needed for a Headroom instance
shared across multiple machines, and is designed separately.

---

### Features

1. **Automatic binary installation** for RTK and/or Headroom (either
   or both, see configuration) if missing on the machine.
2. **Idempotent setup** — RTK's per-agent init (`rtk init --global
   --auto-patch[--gemini|--codex]`, see "Multi-agent scope" for the
   `--auto-patch`/`--codex` interaction) and `headroom wrap claude` are
   only re-run if
   not already configured for that agent (see "Multi-agent scope"
   above for exactly what's checked per agent, and "Wrap/init
   idempotency" below).
3. **Two modes for Headroom**:
   - `local`: a **single `headroom proxy` daemon shared by the whole
     machine**, not one per VS Code window — see "`headroom proxy`
     daemon lifecycle" below.
   - `remote`: the extension just points `ANTHROPIC_BASE_URL` at an
     existing Headroom proxy (a centralized instance deployed via
     `docker-easy-headroom`).
4. **Per-project attribution** — every window's `ANTHROPIC_BASE_URL`
   is suffixed with `/p/<project-slug>` (derived from
   `easy-headroom.projectName` if set, else the VS Code workspace
   name — see `projectSlug()` in `slug.ts`), so Headroom can break
   down usage/savings per project even though the underlying proxy
   process (local mode) is shared across all of them.
5. **RTK can run standalone**, with no notion of a proxy at all — this
   is the default case for a solo dev who only wants shell output
   compression.
6. **Live RTK stats reporting**, `mode=remote` only — a watcher on
   RTK's local SQLite DB, pushing new rows on every change instead of
   relying on a periodic cron job, to the shared remote instance's
   `/rtk/ingest` route (`remoteUrl` + `/rtk/ingest`, not a separately
   configured URL — see `config.rtkIngestEndpoint`). Pushes raw
   per-command rows read directly off the SQLite file, not `rtk
   gain`'s pre-aggregated summary — see "RTK stats reporting —
   row-level sync" below. Never runs in `local` mode, since local mode
   has no ingest aggregator to report to. Independent of
   `headroom.enabled` — `mode` is project-wide (see "Guiding
   principle" at the end of this file), so RTK reports remotely
   whenever `mode=remote`, whether or not Headroom's own proxy is
   enabled.
7. **Status bar** item with a state indicator (proxy up/down, RTK
   active) and a direct shortcut to the dashboard (`/dashboard` on the
   local or remote proxy, depending on mode).
8. **RTK dashboard tab**, alongside Headroom's own dashboard, inside
   the same webview panel — see "RTK dashboard tab" below.
9. **TokenSave install + indexing** — a third, independent optimization
   layer (semantic code-graph MCP server for Claude Code), installed
   and registered automatically, with a single index at the project
   root (`tokensave init`/`sync`) covering the whole project — including
   submodules, since tokensave walks the directory tree rather than
   following git boundaries — so its own savings can be measured, and
   kept fresh afterwards via root-repo git hooks plus a periodic
   fallback timer — see "TokenSave install" and "TokenSave index
   freshness" below, plus its own dashboard tab — see "TokenSave
   dashboard tab" below.
10. **Settings tab**, alongside the others in the same webview panel —
    a simplified, per-setting scope picker on top of the same real
    `contributes.configuration` values, supplementing (not replacing)
    native VS Code Settings — see "Settings tab" below.

### Configuration (`contributes.configuration`)

All settings are `machine`-scoped or narrower (never `window`/`application`),
so each Remote-SSH host keeps its own independent configuration — see
"Remote-SSH considerations". `machine-overridable` settings may
additionally be overridden per workspace/folder (e.g. via a committed
`.vscode/settings.json`); plain `machine` settings may not, to avoid
infra URLs/API keys leaking into a repo through workspace settings.

```jsonc
{
  "easy-headroom.rtk.enabled": {
    "type": "boolean",
    "default": true,
    "scope": "machine-overridable",
    "description": "Install and enable RTK (shell output compression)"
  },
  "easy-headroom.rtk.agents": {
    "type": "array",
    "items": { "type": "string", "enum": ["claude", "gemini", "codex"] },
    "default": ["claude"],
    "scope": "machine-overridable",
    "description": "Which CLI agents to set up RTK for. Each is installed/patched independently — see 'Multi-agent scope (V1)'."
  },
  "easy-headroom.projectName": {
    "type": "string",
    "default": "",
    "scope": "resource",
    "description": "Project name used for Headroom's per-project attribution (/p/<slug>). Empty = auto-detected from the workspace/folder name. Unlike every other setting here, this is intentionally 'resource' scope, not 'machine'/'machine-overridable' — it identifies the project, not the host, so it's meant to be committed in the repo's own .vscode/settings.json rather than tied to a machine."
  },
  "easy-headroom.mode": {
    "type": "string",
    "enum": ["local", "remote"],
    "default": "local",
    "scope": "machine-overridable",
    "description": "Project-wide deployment mode, shared by every active layer (Headroom, RTK stats reporting, TokenSave). local = nothing runs against a shared instance ; remote = active layers report to/use the shared docker-easy-headroom instance at remoteUrl"
  },
  "easy-headroom.remoteUrl": {
    "type": "string",
    "default": "",
    "scope": "machine",
    "description": "URL of the shared docker-easy-headroom instance (required if mode = remote). Used by Headroom's own proxying (when headroom.enabled) and by RTK's stats reporting/aggregation, independently of each other"
  },
  "easy-headroom.proxyToken": {
    "type": "string",
    "default": "",
    "scope": "machine",
    "description": "Token for the remote docker-easy-headroom bundle, must match its HEADROOM_PROXY_TOKEN — sent as X-Headroom-Proxy-Token on the RTK stats reporting/checkpoint endpoints and every proxied Claude Code request (remote mode only)"
  },
  "easy-headroom.headroom.enabled": {
    "type": "boolean",
    "default": false,
    "scope": "machine-overridable",
    "description": "Install and/or use Headroom (proxy compression + cache + output shaping)"
  },
  "easy-headroom.headroom.localPort": {
    "type": "number",
    "default": 8787,
    "scope": "machine-overridable",
    "description": "Local Headroom proxy port (mode = local only)"
  },
  "easy-headroom.rtk.pinnedVersion": {
    "type": "string",
    "default": "",
    "scope": "machine-overridable",
    "description": "Pin RTK to a specific version (e.g. v0.43.0). Empty = always install/update to latest. Use the 'easy-headroom: Select RTK Version' command to pick from detected releases."
  },
  "easy-headroom.headroom.pinnedVersion": {
    "type": "string",
    "default": "",
    "scope": "machine-overridable",
    "description": "Pin Headroom to a specific version (e.g. 0.31.0). Empty = always install/update to latest. Use the 'easy-headroom: Select Headroom Version' command to pick from detected releases."
  },
  "easy-headroom.tokensave.enabled": {
    "type": "boolean",
    "default": true,
    "scope": "machine-overridable",
    "description": "Install and enable TokenSave (semantic code-graph MCP server for Claude Code — replaces raw file reads/greps with targeted graph queries)"
  },
  "easy-headroom.tokensave.pinnedVersion": {
    "type": "string",
    "default": "",
    "scope": "machine-overridable",
    "description": "Pin TokenSave to a specific version (e.g. v7.0.2). Empty = always install/update to latest. Use the 'easy-headroom: Select TokenSave Version' command to pick from detected releases."
  }
}
```

### Expected behavior, case by case

| Config | Behavior |
|---|---|
| `rtk.enabled=true`, `headroom.enabled=false` | RTK only, no network env var touched. Solo dev who just wants shell compression. |
| `rtk.enabled=true`, `headroom.enabled=true`, `mode=local` | RTK + a shared `headroom proxy` daemon for the whole machine (spawned on first need, reused by every window, with `HEADROOM_OUTPUT_SHAPER=1` — see "Start measuring" below), `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/p/<project-slug>`. |
| `rtk.enabled=true`, `headroom.enabled=true`, `mode=remote` | Local RTK + `ANTHROPIC_BASE_URL=<remoteUrl>/p/<project-slug>`. No local Headroom process spawned, no headroom binary/venv needed on the client side — only the RTK CLI is installed. `HEADROOM_OUTPUT_SHAPER=1`/`headroom learn` don't apply here — nothing local to run them against. |
| `rtk.enabled=false`, `headroom.enabled=true` | Headroom only (local or remote per `mode`), `ANTHROPIC_BASE_URL` set accordingly (with `/p/<project-slug>` suffix). RTK binary is never downloaded, `rtk init` is never called, `~/.claude/settings.json` is never touched for the RTK hook. Dev who only wants the API-side proxy/cache, no shell output compression. `headroom learn --verbosity` is skipped too (see below — it needs RTK active). |
| `rtk.enabled=true`, `mode=remote` | (independent of `headroom.enabled`) Active watcher on `~/.local/share/rtk/history.db` (or macOS equivalent `~/Library/Application Support/rtk/history.db`), reads new `commands` rows past the local checkpoint and pushes them to `remoteUrl/rtk/ingest`, ~2s debounce (SQLite WAL fires multiple fs events per transaction) — see "RTK stats reporting — row-level sync". Never started in `local` mode — no ingest aggregator to report to there. `mode` is project-wide, so this fires whether or not Headroom's own proxy is enabled — see "Guiding principle" below. |

### Guiding principle — `mode` is project-wide, `headroom.enabled` is layer-specific

`mode` (`local`/`remote`) and `remoteUrl`/`proxyToken` describe the
shared `docker-easy-headroom` instance itself, not any one layer —
they live at the top level of `contributes.configuration`, not nested
under `headroom.*`. `headroom.enabled` only gates whether Headroom's
own proxy (API compression/cache/output shaping) is used at all.
The two used to be conflated (RTK's reporting endpoints derived from
`headroom.enabled && headroom.mode==='remote'`, so disabling Headroom
silently killed RTK's remote stats too — a real regression, see git
history around the `mode`/`remoteUrl`/`proxyToken` rename). Every
active layer — RTK today, TokenSave in the future — should
independently check `mode`/`remoteUrl` via `config.remoteBaseUrl()`
(or the per-layer endpoint helpers built on it, e.g.
`rtkIngestEndpoint()`) rather than also checking `headroom.enabled`.

### "Start measuring" — output shaper + `headroom learn`

Once RTK is active (`rtk.enabled=true` and the binary installed) and Headroom is running locally
(`headroom.enabled=true`, `mode=local`), two extra steps kick in as part of Headroom setup in
`extension.ts`:

- `ProxyDaemonManager.ensureRunning` (`daemon.ts`) spawns `headroom proxy` with
  `HEADROOM_OUTPUT_SHAPER=1` in its environment, enabling the output shaper.
- `runHeadroomLearn` (`headroom.ts`) then runs `headroom learn --verbosity --apply` (scoped to the
  first workspace folder via `--project`), which learns the user's preferred output verbosity from
  behavioral signals and seeds the output shaper's savings baseline — this is what "reads" RTK's
  activity, since RTK's shell compression is one of the signals feeding that baseline. This is
  heuristic-only (no `--llm-judge`, so no LLM call/API key needed), cheap enough to re-run on every
  activation rather than gated behind an idempotency check like `ensureHeadroomWrapped`.
- Deliberately silent on failure — no `showWarningMessage`/`showErrorMessage` call, per "Setup
  guidance — no popups, ever": this isn't a setup step the user needs to act on, unlike a broken
  RTK/Headroom install.

### RTK install — static binary

Confirmed against the real releases (`github.com/rtk-ai/rtk`): RTK
ships genuine per-platform static binaries (Rust target triples), no
runtime dependency.

- macOS: `~/Library/Application Support/rtk/history.db`
- Linux: `~/.local/share/rtk/history.db`
- Asset selection by `process.platform`/`process.arch`:
  - macOS arm64 → `rtk-aarch64-apple-darwin.tar.gz`
  - macOS x64 → `rtk-x86_64-apple-darwin.tar.gz`
  - Linux x64 → `rtk-x86_64-unknown-linux-musl.tar.gz` (prefer musl
    over gnu: statically linked, runs unmodified across arbitrary
    distros/containers regardless of glibc version — important given
    Remote-SSH hosts are unpredictable)
  - Linux arm64 → `rtk-aarch64-unknown-linux-gnu.tar.gz` (no musl
    variant published for arm64)
  - Windows x64 → `rtk-x86_64-pc-windows-msvc.zip`
- Extract to `context.globalStorageUri` (never inside the extension's
  own install directory), `chmod 755` after extraction (no-op on
  Windows).
- **Versioning**: default is always `latest` — download via the stable
  redirect URL `github.com/rtk-ai/rtk/releases/latest/download/<asset>`,
  which needs no GitHub API call (no rate-limit exposure, safe to hit
  on every activation). If `rtk.pinnedVersion` is set, download from
  `releases/download/<version>/<asset>` instead. The
  `easy-headroom: Select RTK Version` command hits the Releases API
  (`GET /repos/rtk-ai/rtk/releases`, paginated) **only when invoked**
  — not on activation — to populate a `showQuickPick` list (latest
  first), and writes the choice to `rtk.pinnedVersion`.

### RTK stats reporting — row-level sync

`RtkReportingWatcher` (`rtkReporting.ts`) reads RTK's `commands` table
directly (`rtkDb.ts`, via `sql.js` — pure JS/WASM, no native module to
distribute/prebuild per-platform, unlike a native SQLite binding;
contrast with the Docker aggregator, which uses `better-sqlite3`
instead, since that's compiled once inside a controlled Docker build
rather than shipped to arbitrary client machines) instead of spawning
`rtk gain --format json` — the CLI's own summary output doesn't expose
per-row data (timestamps, per-command project attribution), which the
aggregator needs.

- **Reading the raw file directly is safe**: confirmed empirically
  (no lingering `-wal`/`-shm` sidecar files between commands) that
  since RTK is a short-lived per-invocation CLI, not a daemon, its
  WAL auto-checkpoints back into the main `.db` file as soon as that
  invocation's connection closes. No WAL-merging logic needed — the
  existing `fs.watch` + 2s debounce is enough of a buffer.
- **Client identity**: a random UUID (`crypto.randomUUID()`, same
  pattern as `daemon.ts`'s `windowId`), generated once and persisted
  at `rtkInstanceIdPath()` (`paths.ts`, next to `history.db`, not in
  `globalStorageUri` — see that function's own comment for why) via
  `getOrCreateInstanceId()` in `rtkSyncState.ts`. Not hostname- or
  hostname+username-derived: both collide in practice (shared hosts,
  shared host+user, or several VS Code workspaces on one machine that
  don't share a `history.db`).
- **Incremental push, not snapshots**: the last successfully-pushed
  `id` is tracked in a sibling file (`rtkLastPushedIdPath()`), read
  and advanced via `readLastPushedId()`/`writeLastPushedId()`. Each
  push reads rows past that checkpoint (batched, `PUSH_BATCH_SIZE`)
  and POSTs `{ instance_id, id_project, rows }` to
  `config.rtkIngestEndpoint()`. `id_project` is `projectSlug()` — the
  same source Headroom's own `/p/<slug>` attribution uses (see
  "Per-project attribution" above) — sent once per batch, not per row.
- **Startup checkpoint reconciliation**: before the first push of a
  session, `reconcileCheckpoint()` calls `GET
  config.rtkCheckpointEndpoint()` (`<remoteUrl>/rtk/checkpoint`) for
  this `instance_id` and adopts the server's `last_id` if it's ahead
  of the local checkpoint file — the only case that can happen is a
  lost/reset local checkpoint file, since the server's ingest is an
  idempotent upsert (`INSERT OR IGNORE` on `(instance_id, id)` — see
  `../docker/CLAUDE.md`'s "RTK data model") and the local checkpoint
  only ever advances after a push actually succeeds.
- **Build step**: esbuild bundles `sql.js`'s JS glue into
  `dist/extension.js` but can't inline its `.wasm` binary — `esbuild.js`
  copies `node_modules/sql.js/dist/sql-wasm.wasm` to
  `dist/sql-wasm.wasm` as a build step, matched by `rtkDb.ts`'s
  `locateFile: (file) => path.join(__dirname, file)` (bundled CJS
  output's `__dirname` resolves to that same `dist/` directory at
  runtime).

### Headroom install — Python venv, not a binary

Confirmed against the real releases (`github.com/headroomlabs-ai/headroom`):
Headroom only ships Python wheels (`headroom_ai-*.whl`, cp310-abi3) and
an sdist — **no standalone binary at all**. Installing it requires a
working Python 3.10+ on the target host.

- **Interpreter detection is platform-specific**:
  - macOS/Linux: `python3`.
  - Windows: try `py -3` first (the official Python Launcher — only
    present if a real Python is installed, unaffected by the
    Microsoft Store "App Execution Alias" stub); fall back to
    `python` only after checking it isn't that silent stub.
- If no working interpreter is found: **do not attempt to install
  Python** (out of scope, too invasive for an extension — would need
  elevated/admin rights). Surface a clear warning in the status bar +
  a notification, and skip Headroom setup entirely; RTK (if enabled)
  is unaffected.
- If found: create **one venv per host, global** (`<globalStorage>/headroom-venv`),
  **not per-project/per-workspace**. Reasoning: the wheels are
  sizeable (~15-18 MB compiled, per the real release assets), and
  since the `headroom proxy` daemon is itself shared across all
  projects on the host (see below), a per-project venv would just
  mean redundant downloads with no isolation benefit — the "clean"
  property of the venv is isolation from the *system* Python
  (no `sudo`, no polluting global `site-packages`, no
  `externally-managed-environment` errors on modern Debian/Ubuntu),
  not isolation between projects.
- Resulting executable path differs by OS: POSIX `<venv>/bin/headroom`,
  Windows `<venv>\Scripts\headroom.exe`.
- **Versioning**: default is `pip install headroom-ai[proxy,code]`
  (latest, resolved by PyPI's index directly — no GitHub involved). If
  `headroom.pinnedVersion` is set,
  `pip install headroom-ai[proxy,code]==<version>` instead. The
  `easy-headroom: Select Headroom Version` command queries
  `https://pypi.org/pypi/headroom-ai/json` (its `releases` object lists
  every published version, no rate-limit concerns like GitHub) to
  populate a `showQuickPick` (latest first), and writes the choice to
  `headroom.pinnedVersion`.

### TokenSave install — static binary, version-embedded filenames

Confirmed against Headroom's own `tokensave_installer.py` reference
(`aovestdipaperino/tokensave` release assets): TokenSave, like RTK,
ships genuine per-platform static binaries (Rust), no runtime
dependency — but unlike RTK, the asset **filenames embed the version**
(`tokensave-<version>-<arch>-<os>.<ext>`), so there's no stable
`releases/latest/download/<asset>` redirect to hit blind the way RTK's
install does.

- Asset selection by `process.platform`/`process.arch`:
  - macOS arm64 → `tokensave-<version>-aarch64-macos.tar.gz`
  - macOS x64 → **no prebuilt asset published** — `ensureTokensaveInstalled`
    throws, surfaced as a warning by the caller; RTK/Headroom are
    unaffected (same "one layer failing doesn't block the others"
    principle as everywhere else in this file).
  - Linux x64 → `tokensave-<version>-x86_64-linux.tar.gz`
  - Linux arm64 → `tokensave-<version>-aarch64-linux.tar.gz`
  - Windows x64 → `tokensave-<version>-x86_64-windows.zip`
  - Windows arm64 → `tokensave-<version>-aarch64-windows.zip`
- **Versioning**: unlike RTK/Headroom, resolving "latest" needs one
  `GET /repos/aovestdipaperino/tokensave/releases/latest` call to get
  the actual tag before a download URL can even be constructed. Unlike
  the initial rollout, this is no longer a one-time-per-host cost:
  `ensureTokensaveInstalled` now mirrors `ensureHeadroomInstalled`'s
  own periodic-check pattern — a version marker file
  (`tokensaveVersionFile`, `{installedVersion, lastCheckedAt}`) is
  written after every install, and in unpinned mode the latest release
  is re-checked at most once per `CHECK_INTERVAL_MS` (24h) on
  activation, upgrading the binary in place if a newer tag exists.
  This was changed because TokenSave ships frequent releases and the
  binary itself nags on every MCP call once it's out of date
  (`tokensave vX.Y.Z is installed, but vA.B.C is available`) — a
  presence-only check meant that warning could persist indefinitely.
  If `tokensave.pinnedVersion` is set, that tag is installed directly
  (re-installing only if the marker disagrees with it) and no
  "latest" API call happens at all. The `easy-headroom: Select
  TokenSave Version` command still hits the paginated Releases API
  only when invoked, same pattern as RTK/Headroom's own picker
  commands.
- Extract to `context.globalStorageUri` (`tokensave-bin/`), `chmod 755`
  after extraction — identical to RTK's install target/permissions.
  Shared low-level helpers (`pathExists`/`download`/
  `extractZipWindows`/`findBinaryRecursive`) live in `archive.ts`,
  factored out of `rtk.ts` since this is their second, byte-identical
  consumer.
- **`tokensaveBinDir` is prepended to `PATH`** in `applyEnvironment`
  (`daemon.ts`), same as `rtkBinDir`/the Headroom venv's `bin` dir —
  otherwise the binary is only reachable via its absolute path (as
  used internally for MCP registration/indexing), not by typing
  `tokensave` in one of this window's own integrated terminals. Like
  the rest of that PATH prepending, this only covers integrated
  terminals — Claude Code's own CLI process is spawned directly and
  never sees `environmentVariableCollection` (see the comment on
  `applyEnvironment` and `claudeSettings.ts`'s note on the same
  limitation for `ANTHROPIC_BASE_URL`), which is fine here since MCP
  registration already uses the absolute path.
- **Supply-chain integrity — deliberately not pinned by digest here**,
  unlike Headroom's own installer (which SHA-256-verifies every asset
  before executing it, since it runs as a fallback inside `headroom
  wrap` with no user-facing version picker). This extension's RTK
  install has never done digest verification either, and TokenSave
  follows that same existing precedent for consistency rather than
  introducing a new, asymmetric security posture for one of three
  binary installs. Revisit if RTK ever gains digest pinning.
- No MCP-level idempotency check needed on our side — see "MCP server
  registration" below.

### TokenSave index freshness — git hooks + periodic fallback

`ensureTokensaveIndexed` (activation-time) only covers the moment the
window opens — for a long-lived window, the index can drift stale
between activations. There is **one index for the whole project, at
the project root** (`vscode.workspace.workspaceFolders[0]`) — not one
per open workspace folder, since tokensave walks the directory tree
rather than following git boundaries and already picks up submodule
content (`docker/`, `vscode/`) under that same root. Two independent,
best-effort mechanisms keep that single index fresh without requiring
the user to remember to run `tokensave sync`:

- **`installTokensaveGitHooks`** (`tokensave.ts`) writes idempotent,
  marker-guarded (`HOOK_MARKER`) hooks for `post-commit`/`post-merge`/
  `post-checkout`/`post-rewrite` — covering commit, pull, checkout, and
  rebase/amend respectively — into the project root's own
  `.git/hooks/`, calling the tokensave binary via its stable absolute
  path (`storagePaths(context).tokensaveBinPath` never changes across
  version upgrades — the binary is overwritten in place). **Root
  workspace folder only, deliberately**: the extension has no notion
  of git submodules and must not walk into subdirectories looking for
  nested `.git`s, so this is a no-op (no hook installed) unless the
  root's own `.git` is a real directory — a submodule working dir has a
  `.git` *file* instead, pointing at `.git/modules/<name>` in the
  superproject, and is left alone. Any pre-existing hook content at
  that path is appended to, never overwritten, so a user's own custom
  hook survives.
- **`TokensaveSyncTimer`** is the fallback for changes the root-only
  hook can't see — e.g. a commit made inside a submodule (`docker/`,
  `vscode/`), which never fires the root repo's own hooks even though
  that content is covered by the single project-root index — a simple
  30-minute `setInterval` that re-runs the same init-or-sync call as
  activation itself (`ensureTokensaveIndexed`). Same
  `start()`/`dispose()` lifecycle convention as
  `RtkReportingWatcher`/`ProxyDaemonManager.startLifecycleTimers`,
  registered into `context.subscriptions`.

Both are wired into `activate()` right after the initial
`ensureTokensaveIndexed` call. Hook installation failure is logged only
(`log()`), no popup — same "no popups, ever" treatment as any other
non-critical setup step (see "Setup guidance" below).

### Version re-check timer — TokenSave/Headroom self-update in a long-lived window

`ensureTokensaveInstalled`/`ensureHeadroomInstalled` each gate their own
"is a newer release available" check behind a 24h marker file
(`tokensaveVersionFile`/`headroomVersionFile`, unpinned mode only — see
"TokenSave install"/"Headroom install" above), but both were previously
only ever *invoked* once, at `activate()`. A window left open for
several days (no reload) would silently sit on a stale binary
indefinitely — the 24h gate was never actually revisited, since nothing
re-called those functions after activation. `UpdateCheckTimer`
(`updateCheck.ts`) is the fix: a simple hourly `setInterval` (same
`start()`/`dispose()` convention as `TokensaveSyncTimer`) that just
re-calls `ensureTokensaveInstalled` and, when `headroom.enabled` and
`mode === 'local'`, `ensureHeadroomInstalled` again. Ticking hourly
rather than daily is deliberate slack, not a tighter check interval —
each `ensure*` call still only actually hits GitHub/PyPI once its own
24h marker has elapsed, so nearly every tick is a no-op marker-file
read.

- On a TokenSave upgrade, `ensureTokensaveMcpInstalled` re-runs
  afterward (same "safe to re-run every time" reasoning as at
  activation — see "MCP server registration" below).
- On a Headroom upgrade (`headroom.updated === true`),
  `ensureHeadroomWrapped` + `ensureHeadroomMcpInstalled` re-run, and the
  shared proxy daemon is restarted (`daemon.ensureRunning(binPath, {
  forceRestart: true })`) so the new venv actually takes effect instead
  of the old process lingering — mirrors exactly what `activate()`
  itself already does when `ensureHeadroomInstalled` reports `updated`.
  `runHeadroomLearn` also re-runs on upgrade, gated the same way as at
  activation (`rtk.enabled` + an RTK binary present).
- RTK is deliberately not included in this timer — its own install
  always re-resolves "latest" via a stable, rate-limit-safe redirect
  URL on every activation already (see "RTK install — static binary"),
  so it has no marker-file gate to revisit periodically.
- After each tick, the status bar is refreshed (`onChange` callback
  passed in from `extension.ts`) so a version bump or newly-broken
  TokenSave indexing state is reflected without waiting for the status
  bar's own independent 30s poll.
- Constructed and started in `extension.ts` right after `statusBar`
  itself, disposed via `context.subscriptions` like every other timer
  in this file.

### Wrap/init idempotency

Before calling `rtk init --global --auto-patch[...]` for a given agent, check
whether that agent already has the RTK integration (`isRtkIntegrated`
in `rtkAgents.ts` — reads `~/.claude/settings.json` or
`~/.gemini/settings.json` for Claude/Gemini, `~/.codex/AGENTS.md` for
Codex), so it doesn't re-patch on every extension activation (every VS
Code window open). Same pattern for `headroom wrap claude` against
`~/.claude/settings.json` (`isHeadroomWrapped` in `claudeSettings.ts`,
Claude-only — see "Multi-agent scope").

### MCP server registration

`ensureHeadroomMcpInstalled` (`headroom.ts`) runs `headroom mcp install
--proxy-url http://127.0.0.1:<localPort>` right after `ensureHeadroomWrapped`,
local mode only. Unlike `headroom wrap claude`, this one is **not** gated
behind our own idempotency check — deliberately, because `headroom mcp
install` is already non-destructive by itself: if a `claude` (or other
detected agent) registration already exists and differs from what would be
installed (e.g. a stale venv-python invocation from an earlier manual
`headroom mcp install`), it only prints a diff and points at `--force`
rather than overwriting. So `--force` is never passed here — re-running
this on every activation is as cheap and safe as re-running `rtk init`, and
means a genuine drift stays exactly as the user last configured it instead
of getting silently clobbered.

`ensureTokensaveMcpInstalled` (`tokensave.ts`) runs `tokensave install
--agent claude` right after the binary is confirmed present, same
"call it every activation, no gate" treatment — **not independently
confirmed** the way Headroom's diff-and-warn behavior was (that one was
verified against a real install; TokenSave's was not), but this is
still the reasonable default: worst case a redundant, harmless rewrite
of its own MCP registration entry, not a destructive action. Revisit if
a real run ever shows otherwise.

### `headroom proxy` daemon lifecycle (local mode)

The proxy is a **single daemon shared by the whole machine**, not one
process per VS Code window — two windows spawning their own instance
would both try to bind the same port and collide.

- **Singleton spawn**: on activation, GET `/health` on the configured
  port. If it responds, reuse it — do nothing else. If not, spawn
  `headroom proxy` **detached** (`{ detached: true }`, then
  `child.unref()`) so it survives independently of the spawning
  window, and write its PID to a lock file in `globalStorageUri`.
- **Per-project attribution**: each window computes a slug from
  `vscode.workspace.name` (or the first workspace folder's name in a
  single-root window), sanitized to lowercase
  alphanumeric-and-hyphens, and sets its *own* `ANTHROPIC_BASE_URL` —
  via `context.environmentVariableCollection.replace(...)` (scoped
  only to that window's integrated terminals, never a global env
  var) — to `http://127.0.0.1:<port>/p/<slug>` (local) or
  `<remoteUrl>/p/<slug>` (remote). This lets Headroom's dashboard
  break down usage per project even though local mode uses one shared
  process.
  - **`environmentVariableCollection` alone is not enough.** Confirmed
    empirically: Claude Code's own VS Code extension spawns its CLI
    directly rather than through an integrated terminal, so it never
    sees that collection at all — and `headroom wrap claude` already
    wrote a global, slug-less `env.ANTHROPIC_BASE_URL` straight into
    `~/.claude/settings.json`, which is what a Claude Code session
    actually uses in that case, showing "No per-project data yet" on
    the dashboard regardless of `projectName`/workspace name. The fix:
    `applyEnvironment` (`daemon.ts`) also mirrors the same
    `/p/<slug>` URL into `.claude/settings.local.json`'s own `env`
    block for the open workspace folder, via `applyProjectEnv` in
    `claudeSettings.ts` — that project-local file's `env` takes
    precedence over the global `~/.claude/settings.json`'s, so Claude
    Code resolves the right per-project URL no matter how it was
    launched. `HEADROOM_OUTPUT_SHAPER=1` is mirrored there too
    (local mode only) — see "Start measuring" above. Merges into
    (doesn't replace) whatever else already lives in that file;
    `clearProjectEnv` removes both keys again if Headroom gets
    disabled/misconfigured or on `uninstallCleanup`, so a stale URL
    doesn't linger silently.
- **Lifecycle / reaping**: there is no reliable "window closed" signal
  to rely on — confirmed that even VS Code's own Remote-SSH server
  process doesn't clean itself up on disconnect (no built-in idle-kill;
  see https://github.com/microsoft/vscode-remote-release/issues/10403).
  So the daemon must be reaped by the extension itself, independently
  of any single window's lifecycle:
  - Every active window updates its own heartbeat file
    (`<globalStorage>/proxy-clients/<window-id>.heartbeat`, a
    timestamp) every ~30-60s while active.
  - Any active window also runs a periodic reaper (every 2-5 min):
    prune heartbeat files that are missing or stale (older than ~3x
    the tick interval — covers crashed/zombied windows), and if zero
    live windows remain, kill the PID from the lock file and delete
    it. Idempotent by design — killing an already-dead PID is a no-op,
    so it doesn't matter which window's timer happens to run this.
  - Best-effort: `deactivate()` deletes the window's own heartbeat
    file immediately, but correctness must not depend on it firing.

### Status bar

- Single brand icon, `$(shield)`, recolored rather than swapped between
  states — no separate check/error glyph and no `easy-headroom` text
  label next to it (dropped in favor of the icon alone). Stands in for
  `assets/easy-headroom-ico.svg`: VS Code status bar items only render
  Codicons or icons contributed via `contributes.icons` (which needs a
  built icon-font, `.woff`/`.ttf`, not a raw SVG) in `text` — there is
  no API to drop an arbitrary SVG/image into a status bar item. No
  icon-font build pipeline exists for this extension; revisit if exact
  custom-icon fidelity becomes worth the added build step.
- **Health color, click → settings instead of dashboard when broken**:
  deliberately avoids a popup for this (see "Setup guidance" below) —
  instead `HeadroomStatusBar.isBroken()` (`statusBar.ts`) flags the item
  as broken when any independent layer can't function, still keeping
  RTK/Headroom/TokenSave distinguishable in the tooltip rather than
  collapsing them into one generic message (see the "two independent
  layers" guiding principle):
  - RTK: `ensureRtkInitialized`'s failures (`rtk.ts`), passed into
    `HeadroomStatusBar`'s constructor at activation.
  - TokenSave: `ensureTokensaveIndexed`'s failures (`tokensave.ts`),
    passed into `HeadroomStatusBar`'s constructor the same way as RTK's.
  - Headroom: `computeState()`'s `not-initialized` (config genuinely
    missing — e.g. `mode=remote` with empty `remoteUrl`, the only case
    where `!base`) or `error` (health check fails though configured —
    proxy down/crashed) states. Both are real, non-transient problems
    by the time `refresh()` runs, not "still starting up" — `ensureRunning`
    already attempted a spawn once during `activate()` before the status
    bar's own polling begins.
  - Broken state uses `item.backgroundColor = new
    vscode.ThemeColor('statusBarItem.errorBackground')` +
    `item.color = new vscode.ThemeColor('statusBarItem.errorForeground')`
    (a red pill + white icon), not just a recolored icon on the default
    background — confirmed the icon-only recolor (`charts.red`) wasn't
    actually noticeable in practice against the default status bar
    background, hence the pill. `backgroundColor` is restricted by VS
    Code to exactly `statusBarItem.errorBackground`/`warningBackground`
    (any other `ThemeColor` is silently ignored), so red/white is the
    only broken-state combination available this way; the OK state
    keeps the plain recolored icon (`charts.green`, no background) since
    that state doesn't need to grab attention. The click target itself
    doesn't change with broken state (see below) — both Dashboard and
    Settings are always one click away either way, so there's no need to
    switch the command based on state.
- **Content** (VS Code status bar items can't render real
  charts/canvas — text + Codicons only):
  - Bar text: compact numeric summary (e.g. tokens/€ saved), optionally
    followed by a Unicode block sparkline (▁▂▃▄▅▆▇█) built from recent
    savings data points — cheap inline "mini graph", no dependencies.
  - Tooltip (`MarkdownString`): richer breakdown on hover — RTK,
    Headroom, and TokenSave each get their own enabled/disabled line
    (plus a failure summary when broken) — still no real chart, just
    markdown text/table.
  - **Version numbers, one per tool**: RTK's line reads straight off
    the binary (`rtk --version`, parsed via `readRtkVersion` in
    `statusBar.ts`) since it has no version-marker file (see "RTK
    install" above — it always re-resolves "latest" on activation, so
    there's nothing else to read); TokenSave's comes from
    `getInstalledTokensaveVersion` (`tokensave.ts`), reading the same
    marker file `ensureTokensaveInstalled` already writes, no extra
    process spawn. All version strings are passed through `stripV()`
    before display — TokenSave's marker stores the raw GitHub release
    tag (`v7.8.1`), so formatting it as `v${version}` unstripped
    doubles up into `vv7.8.1` (a real regression, caught from a
    screenshot). **Headroom shows local vs. remote as *versions*, not
    a URL** — local mode shows the installed venv version
    (`getInstalledHeadroomVersion`, `headroom.ts`, same marker-file
    read as TokenSave's); remote mode shows the *remote instance's own*
    running version, fetched via `fetchRemoteHeadroomVersion`
    (`daemon.ts` — `/health`'s JSON body carries a `version` field,
    confirmed against a real `headroom proxy`), falling back to
    "(not set)" when `remoteUrl` is empty or "(unreachable)" when the
    fetch fails — the point is to catch a forgotten/stale remote at a
    glance, which a bare URL string doesn't do (a URL can be present
    and still point at nothing running, or at a version far behind the
    local one). All version reads happen on every `refresh()` tick
    (30s poll, plus after every `UpdateCheckTimer` tick) — cheap enough
    (one spawn, two marker-file reads, one extra `/health` fetch in
    remote mode only) not to need caching.
  - The dashboard's own charts are **not** reimplemented in the status
    bar — that's what Headroom's own `/dashboard` is for, opened in an
    embedded VS Code tab on click (see below). No chart-drawing code
    lives in this extension.
- Click → `easy-headroom.openDashboard` (`commands.ts`), opening the
  dashboard directly **inside VS Code** as a `WebviewPanel` tab (no
  address bar/toolbar — that's just how webviews render, no extra
  flag needed), rather than the system browser. No `showQuickPick`
  detour anymore — now that the dashboard has its own Settings tab
  (see "Settings tab" below), there's no reason to make users pick
  between "Dashboard" and "Settings" before landing in the same
  webview either way. `easy-headroom.openSettings` (native VS Code
  settings UI, filtered to this extension) still exists as a separate
  command for the Command Palette, just not wired to the status bar
  click anymore.
  - Headroom's dashboard response sends both `X-Frame-Options: DENY`
    and a `Content-Security-Policy: frame-ancestors 'self'` header
    (confirmed empirically against a real `headroom proxy` — `curl -I`
    on `/dashboard`, and against the actual "violates ... frame-ancestors"
    console error when only the former was stripped), so a plain
    `<iframe>` inside the webview is silently blocked. Instead,
    `openDashboard` (`commands.ts`) runs a local reverse proxy
    (`startDashboardProxy`) in front of the daemon and strips **both**
    headers from every proxied response — `frame-ancestors` blocks
    framing independently of `X-Frame-Options`, so stripping only the
    legacy header isn't enough. `webview.html` is then a minimal
    document embedding a plain `<iframe>` pointed at that local proxy,
    resolved through `vscode.env.asExternalUri()` — **not** the raw
    `127.0.0.1` URL — so the framed page's own client-side asset/API
    calls (made from the webview, which under Remote-SSH is the
    local/UI side) still resolve through Remote-SSH/WSL/Codespaces
    port forwarding.
  - `local` mode: base URL is `http://127.0.0.1:<port>/dashboard`.
  - `remote` mode: base URL is `<remoteUrl>/dashboard` directly — it's
    already externally reachable, no forwarding needed.
  - Only one dashboard panel is kept at a time — a second click
    `.reveal()`s the existing panel instead of creating a duplicate.
  - **TODO**: the embedded dashboard has no notion of which project
    it's for (unlike `ANTHROPIC_BASE_URL`, which gets `/p/<slug>` via
    `projectSlug()` in `slug.ts` — see "Per-project attribution"
    above). The escape-hatch setting now exists
    (`easy-headroom.projectName`, resolved below), but `openDashboard`
    in `commands.ts` still opens the bare `/dashboard` path — it needs
    to route through `/p/<slug>/dashboard` (or equivalent) the same
    way `ANTHROPIC_BASE_URL` does, once Headroom's dashboard exposes a
    per-project view at that path (not confirmed).
- Before enabling `remote` mode, offer a connection test (ping
  `/health`) to avoid an invalid URL silently breaking
  `ANTHROPIC_BASE_URL`.

### RTK dashboard tab

`openDashboard` (`commands.ts`) can show two independent data sources
in the same `WebviewPanel`: Headroom's own `/dashboard` (iframed
through `startDashboardProxy`, see above) and an RTK stats tab backed
by `rtkStats.ts`. Whether each is available is computed separately —
`headroomEnabled` from `config.headroomEnabled()`, `rtkAvailable` from
`rtkDashboardAvailable()` (`config.rtkEnabled()` OR a non-empty
`config.rtkAggregateEndpoint()` — local reads and remote-aggregator
reads are both "RTK is available", independent of whether the
Headroom proxy itself is configured).

- **Tab buttons only when more than one view is available.**
  `showTabs = tabOrder.length > 1` (`tabOrder` built from
  headroom/rtk/tokensave/co2 availability, in that fixed order) gates the
  `.tab-btn` buttons inside `#tabbar`. If only one source is
  configured, that single view renders directly with no switcher UI —
  there's nothing to switch between. This is deliberate, not an
  oversight: a tab bar with one dead/greyed-out button would be worse
  than no tab bar.
- **`#tabbar` itself always renders**, independent of `showTabs` — its
  first child is a `.brand-block` (extension icon + `v<version>`,
  read via `context.extension.packageJSON.version` rather than an
  imported `package.json`, since `tsconfig.json`'s `rootDir: "src"`
  rules out reaching one directory up). This is branding, not a tab —
  it's not clickable and isn't part of the `tabs`/`views` maps in the
  inline script. The icon reaches the webview via
  `panel.webview.asWebviewUri(...)` + `localResourceRoots: [.../assets]`
  on the panel, with a matching `img-src ${cspSource}` CSP directive —
  the default `default-src 'none'` blocks image loads otherwise.
- **No iframe for the RTK tab** — unlike Headroom's dashboard, RTK's
  view is plain HTML/CSS built into the webview document itself
  (cards + bar charts drawn as `<div>` elements, no charting library).
  This sidesteps the `X-Frame-Options`/CSP-stripping proxy dance
  entirely for RTK, and means the RTK tab's CSP needs no `frame-src`
  or `connect-src` — the webview never fetches its own data over the
  network.
- **Message-passing protocol**, extension host ↔ webview:
  - Webview → host: `vscode.postMessage({ type: 'rtk:init' })` on load,
    and `{ type: 'rtk:selectProject', project }` when the project
    `<select>` changes.
  - Host → webview: `panel.webview.onDidReceiveMessage` calls
    `getRtkStats(project)` / `getRtkProjects()` (both from
    `rtkStats.ts`, which itself dispatches local-DB-via-sql.js vs.
    remote-aggregator-fetch based on `useRemote()` —
    `Boolean(config.rtkAggregateEndpoint())`) and posts back
    `{ type: 'rtk:data', stats, projects, selected }`.
  - The extension host does the actual data fetch/read rather than the
    webview doing it directly — same trust boundary as every other
    filesystem/network access this extension does, and avoids
    Remote-SSH port-forwarding concerns for a second endpoint.
- **CSP nonce**: the inline `<script>` in the dashboard webview is
  allowed via `script-src 'nonce-<random>'` (`getNonce()`,
  `crypto.randomBytes(16).toString('hex')`), not `'unsafe-inline'` —
  `style-src` still uses `'unsafe-inline'` since the inline styles are
  static and pose no injection risk.
- **Privacy**: exactly like `rtkDb.ts`/`server.js`, the dashboard tab
  never renders or requests `original_cmd`/`rtk_cmd` — only aggregate
  stats reach the webview.
- **Not yet visually verified**: this UI compiles and builds cleanly
  (`npm run typecheck`, `npm run compile`) but has not been exercised
  in a running Extension Development Host — treat rendering/UX
  correctness as unverified until manually tested.

### TokenSave dashboard tab

Third tab in `tabOrder` (`headroom → rtk → tokensave → co2 → settings`),
gated by `tokensaveDashboardAvailable()` (`config.tokensaveEnabled()`
OR a non-empty `config.tokensaveAggregateEndpoint()` — same
local-or-remote-aggregator "is it available" logic as RTK's own
`rtkDashboardAvailable()`, now that TokenSave has a remote mode too).
`loadTokensaveDashboardData()` in `commands.ts` dispatches on
`tokensaveUseRemote()` (`Boolean(config.tokensaveAggregateEndpoint())`):
local mode reads via `tokensaveStats.ts` (`getTokensaveGain`/
`getTokensaveHistory`/`getTokensaveStatus`, each a thin
`runCapture(tokensaveBinPath, [...], cwd)` + `JSON.parse` around
`tokensave gain --json`/`tokensave status --json`) for the single
project-root folder (`vscode.workspace.workspaceFolders[0]`) — same
one index the rest of TokenSave uses, see "TokenSave index freshness"
above; remote mode instead fetches `getRemoteTokensaveStats()`/
`getRemoteTokensaveProjects()` (`tokensaveStats.ts`, same
attach-the-proxy-token-and-swallow-failures pattern as `rtkStats.ts`'s
remote path).
- **Project selector, remote mode only** — mirrors RTK's exactly: a
  project `<select>` defaulting to the current project rather than
  "all projects" (`currentTokensaveProjectId()` — `projectSlug()` when
  `config.tokensaveAggregateEndpoint()` is set, since `id_project`
  server-side is the slug there, same
  `vscode.workspace.workspaceFolders[0]?.uri.fsPath` fallback otherwise
  as RTK's `currentRtkProjectId()`), plus a project breakdown table fed
  by `getRemoteTokensaveProjects()`. Local mode still has no folder
  picker at all: there is exactly one index for the whole workspace, so
  nothing to switch between.
- **Freshness, not just savings — local mode only**: index health
  (symbol/file counts, DB size, `last_sync_at` surfaced as
  `lastSyncAt`) only comes from the local CLI's `status` call — the
  remote aggregator has no index-health concept, so `status` is
  `undefined` in remote mode and the freshness note is skipped there.
- **Range picker, not RTK's fixed daily/weekly/monthly — local mode
  only**: `tokensave gain --range` only accepts
  `today`/`7d`/`30d`/`month`/`all` (no server-side weekly/monthly
  bucketing), so local mode has one history chart plus a range
  `<select>` instead of three fixed charts. Remote mode instead reuses
  RTK's fixed daily/weekly/monthly buckets, since `/tokensave/aggregate`
  mirrors `/rtk/aggregate`'s response shape exactly (see
  `docker/CLAUDE.md`'s "TokenSave data model").
- **`usd` is always `0` in remote mode**: the remote aggregator's
  `savings` table has no dollar-cost column (see "TokenSave data
  model"), unlike the local CLI's `gain`/`history`, which do carry a
  real `usd` figure — `loadTokensaveDashboardData()` hardcodes `usd: 0`
  on every remote-mode `gain`/`history` point rather than fabricating a
  conversion the server has no basis for.
- **Message-passing protocol**, mirroring RTK's `rtk:init`/
  `rtk:selectProject` split: webview → host sends
  `{ type: 'tokensave:init' }` on load and
  `{ type: 'tokensave:query', range, project }` on range or project
  `<select>` change; host → webview replies
  `{ type: 'tokensave:data', gain, history, status, projects, selected }`.
- **Degrades to "no data" on any failure**: `runJson()` in
  `tokensaveStats.ts` catches and swallows every local-CLI error
  (missing binary, never-indexed folder, malformed JSON) the same way
  RTK's dashboard tolerates an empty `history.db`; `getRemoteTokensaveStats`/
  `getRemoteTokensaveProjects` do the same for the remote path (network
  failure, non-2xx, malformed body) — the tab shows its empty states
  (`#ts-index-empty`, zeroed cards) rather than surfacing an error.
- **Not yet visually verified** — same caveat as the RTK tab above:
  compiles and builds cleanly but hasn't been exercised in a running
  Extension Development Host.

### CO2 tab (rides along with Headroom, not RTK)

Its own dashboard tab (`#view-co2` in `renderDashboardHtml()`), shown
whenever the Headroom tab is (`co2Available = headroomAvailable`) —
folded into the same tab-order/`showTabs` logic as headroom/rtk rather
than a separate availability check. Tab order is fixed as
headroom → rtk → tokensave → co2 (`tabOrder` in `renderDashboardHtml()`)
— CO2 is the derived/secondary metric, so it sits last after the tabs
with their own raw data sources. Deliberately **not** available
off RTK alone: RTK's schema (client SQLite and the Docker aggregator's
`commands` table) has no model column at all, so it has no way to
attribute tokens to a model, and per-model attribution is the whole
basis for a carbon estimate. Headroom, being an API-layer proxy rather
than a shell wrapper, does see the `model` field per request and
already tracks per-model token stats — this piggybacks on that, not on
anything new.

The tab has three parts: a static methodology/disclaimer paragraph, a
headline comparison (total sent vs. avoided), and a per-model
table with inline mini-bars (`co2-cell-fill`) — all fed by the same
`carbon` object already computed server-side per poll, specifically
its `perModel` array (previously computed but unused before this tab
existed). Sent uses `--vscode-charts-blue`, avoided (Headroom)
`--vscode-charts-green`, consistently across the headline bars, the
legend, and the table columns — deliberately vscode's own theme
tokens rather than a hardcoded hex palette, so it re-themes with the
editor automatically; this is the exception to running the `dataviz`
skill's palette validator (which needs concrete hex), consistent with
this file's other charts (e.g. the RTK trend chart) already doing the
same. The two former inline cards on the Headroom tab were removed in
favor of this tab — not duplicated — to avoid maintaining the same
numbers in two places.

- **RTK's and TokenSave's savings are each allocated across models, not
  shown separately**: neither has per-model attribution (see above —
  RTK's schema has no model column; TokenSave's `gain`/`history` are
  similarly model-agnostic), but their aggregate `saved` tokens can
  dwarf Headroom's own — showing only Headroom's figure understated the
  real savings. `renderCo2(carbon, rtkTotalSaved, tokensaveTotalSaved)`
  (inline webview script) allocates each pool's model-agnostic
  saved-token total across models using each model's *share of
  Headroom's sent tokens* as a proxy distribution (a shared `allocate()`
  helper, called once per source), then applies that same model's
  `sentGrams / sentTokens` coefficient (backed out client-side — no new
  backend payload) to convert the allocated share to grams
  (`perModelRtkAvoided`/`perModelTokensaveAvoided`, one entry per
  `carbon.perModel` row). This is a proxy on top of a proxy — RTK's/
  TokenSave's usage mix may not actually match Headroom's — so each
  renders as its own column in the per-model table ("CO₂ avoided (RTK,
  est.)" `--vscode-charts-purple`, "CO₂ avoided (TokenSave, est.)"
  `--vscode-charts-orange`, showing "–" per row when not yet
  computable), its own headline row, and its own legend swatch — never
  merged into the green Headroom figures or into each other. Each is
  only computed when its own `*TotalSaved > 0` and Headroom has sent
  tokens to build a distribution from; otherwise that source's
  headline/legend row is omitted and its table column reads "–"
  throughout — independent per source, so e.g. RTK disabled and
  TokenSave enabled still shows the TokenSave column alone. The tab-bar
  metric (`tab-co2-metric`) sums Headroom's, RTK's, and TokenSave's
  avoided grams into one combined figure. A dedicated italic disclaimer
  paragraph (`#co2-calc-disclaimer`, below the table, empty until at
  least one of RTK/TokenSave is allocable, naming whichever of the two
  actually contributed) spells out the extra approximation layer — kept
  out of the top intro paragraph so it only appears once at least one
  of those figures is actually showing.
  `latestTokensaveSaved` is populated from the same `tokensave:data`
  message (`msg.gain.saved_tokens`) the TokenSave tab itself renders
  from — no new request, same "no new backend payload" property as
  RTK's own wiring — and re-triggers `renderCo2()` on every
  `headroom:stats`/`rtk:data`/`tokensave:data` message, same as
  `latestRtkSaved`.

- **Data source, no new request**: `computeCarbonEstimate()`
  (`carbonFootprint.ts`) is fed `persistent_savings.by_model` from the
  same raw `/stats` JSON `onHeadroomStats` already taps in
  `startDashboardProxy` — not `savings.by_model` (a same-named but
  different, decoy field: just `{model: request_count}`, no token
  data). `persistent_savings` is Headroom's `SavingsTracker
  .stats_preview()` and its `by_model` entries carry
  `tokens_saved`/`total_input_tokens` per model, which is what's
  multiplied by a coefficient.
- **Coefficients shipped as a static asset**,
  `resources/carbon-coefficients.json`, generated by running
  `scripts/fetch-carbon-coefficients.js` (manual, not part of the
  build — depends on a third-party page) against
  https://carbon-llm.com/methodology's published per-model g CO2e/1k
  token table, Claude rows only. Copied into `dist/` by
  `esbuild.js`'s `copyCarbonCoefficients()`, same convention as
  `sql-wasm.wasm`.
- **Model-generation mismatch, handled by design, not by accident**:
  carbon-llm.com's catalog only goes up to Claude 3/4-era slugs
  (`claude-3-5-sonnet`, `claude-4-opus`, `claude-4-sonnet`, ...) — it
  predates whatever's actually live today (e.g. `claude-sonnet-5`), so
  no current model will ever exact-match. `matchCoefficient()` in
  `carbonFootprint.ts` falls back by tier (opus/sonnet/haiku substring
  match → the newest cataloged entry for that tier), forced to
  `confidence: "estimated"` regardless of what the catalog said for
  that entry, and falls back again to a generic 0.30 g/1k ("GPT-4
  class") coefficient for anything that doesn't even match a tier —
  this is carbon-llm.com's own documented policy for unrecognized
  slugs, not an invented number.
- **Framing matters here**: the tab's intro paragraph states up front
  that this is an indicative, non-official estimate (and, since the
  RTK-/TokenSave-allocation feature, that those figures are a further
  approximation layered on top). Neither Anthropic nor Headroom
  publish a per-token carbon figure — don't let any future copy on
  this tab imply otherwise.
- **Display text uses "CO₂" (U+2082 subscript two), not "CO2"** —
  applies to every user-visible string on this tab (tab title, intro
  paragraph, legend, headline labels, table headers, tooltips). Code
  identifiers (`renderCo2`, `co2Available`, `.co2-*` classes,
  `#view-co2`/`#co2-*` ids, the `carbon`/`CarbonEstimate` types in
  `carbonFootprint.ts`) stay as `co2`/`CO2` — only rendered text
  changes.

### Settings tab

A fourth dashboard tab (`#view-settings` / `settingsMeta.ts`),
supplementing rather than replacing native VS Code Settings
(`@ext:vitalyn.easy-headroom` filter, `easy-headroom.openSettings` —
still there for anyone who prefers it). Exists because navigating
User/Remote/Workspace/Folder scopes for 9 settings via the native UI
is more friction than this extension's needs warrant.

- **Always reachable, unlike the other three tabs**: `tabOrder`
  unconditionally pushes `'settings'` last, and `openDashboard()` no
  longer early-returns when both Headroom and RTK are disabled — it's
  the only way to turn either back on from inside the dashboard once
  nothing else is showing. When it's the sole available tab,
  `showTabs` is false and it renders directly (same convention as any
  single-tab case elsewhere in this file).
- **Misconfigured Headroom jumps straight here instead of blocking the
  whole webview**: if `headroom.enabled` is true but `mode`/`remoteUrl`
  resolve to an empty target (e.g. remote mode with no `remoteUrl`
  set), `openDashboard()` still shows the existing one-shot
  `showErrorMessage` (no new popups — see "Setup guidance" below) but
  no longer `return`s before creating the panel. It flips its local
  `headroomAvailable` to false for the rest of the function (so the
  Headroom iframe/proxy is skipped, same as if the layer were disabled
  outright) and passes `forceTab: 'settings'` into
  `renderDashboardHtml()`, which uses it in place of `tabOrder[0]` for
  `defaultTab`. If the panel is already open, `openDashboard()` instead
  posts a `dashboard:focusTab` message that the webview's script
  handles via the same `activateTab()` helper the tab buttons'
  click listeners call — the only message-driven (non-click) tab
  switch in the dashboard.
- **`contributes.configuration` in `package.json` is the single source
  of truth** for type/default/description/scope —
  `buildSettingsSnapshot()` reads it via
  `context.extension.packageJSON` (same pattern the status bar uses
  for the extension version) rather than duplicating that metadata, so
  this tab can't drift from what the native Settings UI shows for the
  same key.
- **Writing at a broader scope offers to clear shadowing narrower ones,
  with confirmation**: VS Code's own precedence (User < Workspace <
  WorkspaceFolder) means writing at, say, Global while a Workspace
  override already exists (e.g. a team-shared `.vscode/settings.json`
  or `.code-workspace`) is silently ineffective — the narrower value
  keeps winning. `shadowingTargets()` (`settingsMeta.ts`) checks
  `cfg.inspect()` for any narrower scope holding an explicit value
  before a `settings:set` write; if any exist, the `openDashboard`
  message handler shows a modal `showWarningMessage` (`Clear and
  Save` / cancel) naming the shadowing scope(s) before calling
  `clearSetting()` on each and then `writeSetting()`. Deliberately a
  confirmation, not a silent auto-clear or a passive warning-only
  indicator — in a team context that narrower value is often a
  colleague's committed choice, not a leftover from this dashboard,
  so an unprompted delete would be a real, hard-to-notice loss.
- **Real config writes, not a separate store**: `writeSetting()` calls
  `vscode.workspace.getConfiguration('easy-headroom', resource).update(...)`
  against the real `ConfigurationTarget` (Global/Workspace/WorkspaceFolder
  — there's no separate "Remote" target at the API level; VS Code
  itself routes a Global write to local or Remote User `settings.json`
  depending on context). Writing at WorkspaceFolder level requires the
  `WorkspaceConfiguration` handle itself to be resource-scoped (a
  folder `Uri`), which only makes sense in a single-root workspace —
  multi-root and no-workspace cases exclude `WorkspaceFolder` entirely
  (`allowedTargets()`). The existing `onDidChangeConfiguration`
  listener in `extension.ts` (`daemon.applyEnvironment()`) picks up
  these writes automatically, no new listener needed for that.
- **Per-setting allowed vs. recommended target, not just one picker**:
  `allowedTargets()` derives the mechanically-valid scope list from
  each setting's declared `scope` (`machine`/`application` → User
  only; `machine-overridable`/`window` → User+Workspace; everything
  else → all three), further filtered by whether a workspace is open
  and single- vs. multi-root. `RECOMMENDED_TARGET` is a separate,
  hand-picked *default selection* within that allowed set, for settings
  where the most-permissive level isn't the sensible default value —
  falls back to `allowed[0]` if the hand-picked value isn't actually in
  the allowed set for the current workspace context.
  `RESTRICT_ALLOWED` goes further and removes an option from `allowed`
  entirely, for cases where the declared `scope` is simply more
  permissive than makes sense: `projectName` is `resource` scoped (so
  User is technically legal) but is a per-project fact, never a global
  preference, so User is excluded outright rather than merely
  deprioritized — the scope `<select>` for that field never offers it.
  Falls back to the unrestricted list if the restriction would leave
  zero options (no workspace open at all — nothing to restrict to).
- **"User" relabels to "User (Remote)" in a Remote-SSH/WSL/container
  window** (`vscode.env.remoteName`, pushed alongside each
  `settings:data` message) — there's no separate write target for
  "Remote" at the API level (see above), so this is a client-side
  label change only, matching how native Settings names that same tab
  in a remote context.
- **`machine-overridable` + WorkspaceFolder is an unverified
  assumption**: `allowedTargets()` currently excludes `WorkspaceFolder`
  for that scope (only Global/Workspace), following the scope's name
  literally, but this hasn't been confirmed against a real multi-root
  workspace — check before relying on it.
- **Conditional visibility is hardcoded, not a rules engine** — same
  philosophy as the CO2/RTK special-casing elsewhere in this file:
  `updateVisibility()` in the inline webview script hides
  `remoteUrl`/`proxyToken` unless `mode === 'remote'` (`mode` itself is
  always shown — it's project-wide, not tied to any one layer's
  enabled flag, see "Guiding principle" above); hides
  `headroom.localPort` unless `headroom.enabled && mode === 'local'`;
  hides `headroom.pinnedVersion` unless `headroom.enabled`; hides
  `rtk.agents`/`rtk.pinnedVersion` unless `rtk.enabled`; hides
  `tokensave.pinnedVersion` unless `tokensave.enabled`. Re-runs on
  every relevant field's `change`
  event via an optimistic local update to `item.value.effective`
  before the round trip to the extension host completes.
- **Data flows by push, same as the RTK tab** — no settings snapshot
  is embedded in the initial HTML; the webview posts
  `{type:'settings:init'}` on load and the host replies with
  `{type:'settings:data', groups}` from `buildSettingsSnapshot()`.
  Every write (`settings:set`) and pinned-version pick
  (`settings:pickVersion`, delegating to the existing
  `selectRtkVersion`/`selectHeadroomVersion`/`selectTokensaveVersion`
  QuickPick flows rather than reimplementing them) triggers a fresh
  snapshot push back to the webview. A panel-scoped
  `onDidChangeConfiguration` listener (disposed alongside the panel)
  also re-pushes the snapshot whenever `easy-headroom` config changes
  externally (native Settings UI, another window, a hand-edited
  `settings.json`), so this tab can't show stale values.
- **`pinnedVersion` fields keep the existing QuickPick UX**: rather
  than a raw text input, each renders a "Pick from releases…" button
  (`data-pick-version`) that calls the same version-selection commands
  used elsewhere (`easy-headroom.selectRtkVersion` and friends), which
  already fetch releases from GitHub and show the
  reload-window reminder.

### Setup guidance — no popups, ever

Deliberate choice: never prompt with a prime-time popup or modal
dialog, at first activation or otherwise, even for an initial-setup
nudge. Misconfiguration is instead surfaced through two channels only:
the existing one-shot `showWarningMessage`/`showErrorMessage` calls
already in `extension.ts`/`commands.ts` (unchanged, not new
notifications), and the status bar's broken state (red background,
click → settings — see "Status bar" above), which stays visible for as
long as the problem persists rather than a toast that can be missed or
dismissed.

### Remote-SSH considerations

~90% of the intended usage is over Remote-SSH, so this isn't an edge
case — it drives several requirements above:

- **`"extensionKind": ["workspace"]` is mandatory** in `package.json`.
  Everything the extension does (filesystem access, binary/venv
  install, daemon spawn) must execute on the remote host's extension
  host, not the local UI-side one — otherwise these actions would
  silently run against the wrong machine, with zero effect on the
  environment where Claude Code/RTK/Headroom actually run.
- **Configuration scope**: `easy-headroom.*` settings should use
  `machine`/`machine-overridable` scope rather than the default
  `window`, so each remote host keeps its own independent RTK/Headroom
  configuration instead of Settings Sync propagating one global toggle
  (and one `localPort`) to every machine.
- Everywhere this spec says "the machine" (binary/venv storage,
  `history.db` path, the daemon process, `~/.claude/settings.json`) —
  in Remote-SSH usage this means the **remote host**, not the local
  client.
- `vscode.env.openExternal` for the dashboard link and the daemon's
  `127.0.0.1` binding both work transparently through Remote-SSH's
  port/URI forwarding — no special-casing needed there.

### `contributes.commands` and activation

- `activationEvents`: `onStartupFinished` — activates once VS Code has
  finished its own startup, rather than eagerly blocking window launch.
- Commands exposed in the Command Palette:
  - `easy-headroom.openDashboard` — same action as clicking the status
    bar item (see "Status bar").
  - `easy-headroom.stopProxy` — manually stop the shared `headroom
    proxy` daemon (local mode). Mostly a manual escape hatch; normal
    lifecycle is handled by the heartbeat reaper, not by the user.
  - `easy-headroom.selectRtkVersion` / `easy-headroom.selectHeadroomVersion`
    / `easy-headroom.selectTokensaveVersion` — QuickPick of detected
    versions (see "Versioning" under each install section), writes the
    choice to the matching `pinnedVersion` setting, then reinstalls.
  - `easy-headroom.uninstallCleanup` — see "Uninstall / cleanup" below.

### Uninstall / cleanup

VS Code gives extensions no reliable hook to intercept actual
uninstallation (no `onWillUninstall`, no chance to prompt the user at
that point) — so cleanup can't be automatic when the user clicks
"Uninstall" in the Extensions view.

- Practical answer: a manual command, `easy-headroom: Uninstall /
  Clean Up`, documented in the README as a step to run **before**
  uninstalling the extension if a full cleanup is wanted.
- Default behavior when invoked: single confirmation prompt, then
  clean up everything — remove the RTK integration for every agent in
  `rtk.agents` (Codex's AGENTS.md block is left in place, see
  "Multi-agent scope"), remove the Headroom wrap from
  `~/.claude/settings.json`, best-effort `tokensave uninstall --agent
  claude` (failure here doesn't block the rest of cleanup — the binary
  is deleted regardless, a stale MCP entry is left for manual removal),
  delete the downloaded RTK binary, the Headroom venv, and the
  TokenSave binary from `globalStorageUri`, stop the shared proxy
  daemon if running.

### Security / practices to follow

- Never log or transmit the actual content of shell commands beyond
  what RTK already stores natively (the reporting endpoint only relays
  what `rtk gain --format json` would expose anyway).
- `proxyToken` is always sent as an `X-Headroom-Proxy-Token`
  header (never a query string, never `Authorization`), from these
  places, all `remote` mode only:
  - the RTK ingest and checkpoint endpoints (`rtkReporting.ts`), and
    the RTK dashboard tab's remote aggregate/projects fetch
    (`rtkStats.ts`);
  - the TokenSave ingest and checkpoint endpoints
    (`tokensaveReporting.ts`), and the TokenSave dashboard tab's remote
    aggregate/projects fetch (`tokensaveStats.ts`) — same pattern as
    RTK's, one layer over;
  - every proxied Claude Code request, via the `ANTHROPIC_CUSTOM_HEADERS`
    env var (Claude Code's own mechanism for attaching extra headers to
    outbound API requests), set through `applyProjectEnv` in
    `daemon.ts`'s `applyEnvironment`;
  - the dashboard webview's Headroom-iframe traffic, attached by the
    extension's own local reverse proxy (`startDashboardProxy` in
    `commands.ts`) on every request it forwards — the one place this
    can be done for that traffic, since neither a plain browser nor
    Headroom's own client-rendered dashboard JS can set a custom header
    on themselves. (The RTK/TokenSave tabs' own remote fetches don't go
    through this proxy at all — the extension host makes those requests
    directly, attaching the header itself, same trust boundary as every
    other filesystem/network access this extension does.)

  Deliberately not `Authorization` in any of these: that header already
  carries the user's real Anthropic OAuth/API credentials on the proxied
  API path, and Headroom's own proxy accepts `X-Headroom-Proxy-Token` as
  a separate, non-colliding gate token — see the `easy-headroom`
  service's token section in `../docker/CLAUDE.md`. The Docker bundle's
  `easy-headroom` never injects this header itself, for any proxied
  traffic — every one of the three call sites above is what's
  responsible for sending it.
- No personal infra values (URL, key) hardcoded in the published
  extension — everything must come from user configuration.

---

## `docker-easy-headroom`

Full spec lives in that project's own `CLAUDE.md`, under
[`../docker/`](../docker/CLAUDE.md) — first working cut, no longer a
placeholder.

---

## Open questions / to verify during implementation

- Confirm the exact behavior of `headroom wrap claude` (which files it
  touches precisely) before calling it automatically from the
  extension, so it never clobbers an existing config.
- Whether `headroom proxy` has a native idle-shutdown flag — if it
  does, it could replace/simplify the heartbeat-based reaper described
  in "`headroom proxy` daemon lifecycle".
- Confirm `headroom proxy` actually routes `/p/<project-slug>/...`
  correctly for every API path it proxies (not just verified for the
  happy path), and how it behaves if the slug is empty/unset (no
  workspace open).

Resolved: `headroom-ai` is also published on PyPI (confirmed, same
version as the latest GitHub release) — install is a plain
`pip install headroom-ai[proxy,code]` inside the venv, no need to
resolve GitHub release asset URLs for Headroom at all.

Resolved: distribution is via the official VS Code Marketplace only —
no independent self-update mechanism, no manually shared `.vsix`
workflow to support. Publishing itself is a local script, not CI/CD
(`../scripts/publish-vscode.sh` and `../scripts/release-vscode.sh` in
the root repo — deliberately not committed inside this submodule, since
they're publish-process tooling for the maintainer, not part of the
published extension). `publish-vscode.sh` packages and publishes the
vsix to the Marketplace; `release-vscode.sh` then mirrors that same
vsix as a GitHub release asset on `studio-vitalyn/easy-headroom-vscode`
— a changelog/backup artifact only, not an alternate install path.
`package.json`'s `version` carries a `-dev` suffix while work is in
progress (e.g. `0.2.0-dev`), both as a visible "not yet released"
marker and because it makes an accidental double-publish of an
unfinished version fail loudly. `publish-vscode.sh` strips it (vsce
requires a strict `x.y.z` version anyway), packages/publishes under
the stripped version, then restores the `-dev` `package.json` via a
`trap`; bumping to the *next* `-dev` version afterward, to resume
work, is a manual step. `release-vscode.sh` independently derives the
same stripped version to find/tag the already-built vsix — it never
touches `package.json`.
Headroom install is a global-per-host Python venv
(`headroom-ai[proxy,code]`), not a downloaded binary — see "Headroom
install — Python venv, not a binary".

Resolved: RTK's per-agent behavior is confirmed empirically against a
real rtk 0.43.0 install (`rtk init --help` + `--dry-run`) — Gemini's
settings path is `~/.gemini/settings.json`, Codex's global path is
`~/.codex/AGENTS.md` (or `$CODEX_HOME`), `--auto-patch` is required for
Claude/Gemini (headless spawn has no stdin to answer rtk's
patch-confirmation prompt) and forbidden for Codex, and `rtk init`
never checks whether the target agent is actually installed on the
machine — see "Multi-agent scope (V1)".

Resolved: both RTK and Headroom default to `latest` (rate-limit-safe
stable URL for RTK, plain PyPI resolution for Headroom); a per-tool
`pinnedVersion` setting plus a "Select Version" command allow pinning
a specific detected version — see "Versioning" under each install
section. Uninstall cleanup is a manual command
(`easy-headroom.uninstallCleanup`, since VS Code has no uninstall
hook), defaulting to a full cleanup after one confirmation. Activation
is `onStartupFinished`; the full command list is now enumerated under
"`contributes.commands` and activation".

Resolved: the per-project slug escape hatch is `easy-headroom.projectName`
(`config.ts` / `slug.ts`), deliberately `resource`-scoped rather than
`machine`/`machine-overridable` like every other setting — it names the
project, not the host, so it belongs in a committed
`.vscode/settings.json`. Still open: `openDashboard` doesn't route
through `/p/<slug>` yet — see the TODO under "Status bar".

Resolved: TokenSave is rolled out enabled-by-default
(`tokensave.enabled=true`), Claude-Code-only, with no dashboard tab yet
— the decision (2026-07-24) was to ship the install/index/MCP-registration
plumbing first and gather real usage data across several projects over
a few days before deciding whether a dashboard is worth building at
all, rather than building one speculatively. See "TokenSave install"
above for the install/versioning details.

## Guiding principle for Claude Code

Always keep RTK, Headroom, and TokenSave as three strictly independent
layers in the codebase (no function should assume one implies another)
— this is the principle that emerged from all the debugging that led
to this project, and it must remain true in the implementation. The
same independence applies across RTK's agents: no function should
assume that because one agent is configured/working, another is too
(see "Multi-agent scope (V1)").