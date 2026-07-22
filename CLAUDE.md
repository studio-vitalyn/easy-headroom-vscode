# easy-headroom

VS Code extension that installs, configures, and manages **RTK** and
**Headroom** automatically, to reduce token consumption for CLI coding
agents.

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

A separate, optional project — **`docker-easy-headroom`** — provides a
Docker bundle for teams who want a centralized Headroom instance shared
across multiple machines/containers. It has a first working cut — see
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
                     aggregation service, for teams / multi-machine setups
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
     existing Headroom proxy (team using a deployed `docker-easy-headroom`).
4. **Per-project attribution** — every window's `ANTHROPIC_BASE_URL`
   is suffixed with `/p/<project-slug>` (derived from
   `easy-headroom.projectName` if set, else the VS Code workspace
   name — see `projectSlug()` in `slug.ts`), so Headroom can break
   down usage/savings per project even though the underlying proxy
   process (local mode) is shared across all of them.
5. **RTK can run standalone**, with no notion of a proxy at all — this
   is the default case for a solo dev who only wants shell output
   compression.
6. **Live RTK stats reporting**, `headroom.mode=remote` only — a
   watcher on RTK's local SQLite DB, pushing new rows on every change
   instead of relying on a periodic cron job, to the same remote
   Headroom instance's `/rtk/ingest` route (`headroom.remoteUrl` +
   `/rtk/ingest`, not a separately configured URL — see
   `config.rtkIngestEndpoint`). Pushes raw per-command rows read
   directly off the SQLite file, not `rtk gain`'s pre-aggregated
   summary — see "RTK stats reporting — row-level sync" below. Never
   runs in `local` mode, since local mode has no ingest aggregator to
   report to.
7. **Status bar** item with a state indicator (proxy up/down, RTK
   active) and a direct shortcut to the dashboard (`/dashboard` on the
   local or remote proxy, depending on mode).
8. **RTK dashboard tab**, alongside Headroom's own dashboard, inside
   the same webview panel — see "RTK dashboard tab" below.

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
  "easy-headroom.headroom.enabled": {
    "type": "boolean",
    "default": false,
    "scope": "machine-overridable",
    "description": "Install and/or use Headroom (proxy compression + cache + output shaping)"
  },
  "easy-headroom.headroom.mode": {
    "type": "string",
    "enum": ["local", "remote"],
    "default": "local",
    "scope": "machine-overridable",
    "description": "local = headroom proxy spawned and managed on this machine ; remote = use an already-deployed Headroom proxy elsewhere"
  },
  "easy-headroom.headroom.remoteUrl": {
    "type": "string",
    "default": "",
    "scope": "machine",
    "description": "URL of the remote Headroom proxy (required if mode = remote)"
  },
  "easy-headroom.headroom.proxyToken": {
    "type": "string",
    "default": "",
    "scope": "machine",
    "description": "Token for the remote Headroom bundle (headroom.remoteUrl), must match its HEADROOM_PROXY_TOKEN — sent as X-Headroom-Proxy-Token on the RTK stats reporting/checkpoint endpoints and every proxied Claude Code request (remote mode only)"
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
| `rtk.enabled=true`, `headroom.enabled=true`, `mode=remote` | (in addition to the row above) Active watcher on `~/.local/share/rtk/history.db` (or macOS equivalent `~/Library/Application Support/rtk/history.db`), reads new `commands` rows past the local checkpoint and pushes them to `headroom.remoteUrl/rtk/ingest`, ~2s debounce (SQLite WAL fires multiple fs events per transaction) — see "RTK stats reporting — row-level sync". Never started in `local` mode — no ingest aggregator to report to there. |

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

- Dynamic icon based on the shared daemon's state: proxy up
  (green/check), RTK not yet initialized (warning), connection error
  (error) — based on a periodic `/health` or `/readyz` ping.
- **Broken state (red background, click → settings instead of dashboard)**:
  deliberately avoids a popup for this (see "Setup guidance" below) —
  instead `HeadroomStatusBar.isBroken()` (`statusBar.ts`) flags the item
  as broken when either independent layer can't function, still keeping
  RTK/Headroom distinguishable in the tooltip rather than collapsing
  them into one generic message (see the "two independent layers"
  guiding principle):
  - RTK: `ensureRtkInitialized`'s failures (`rtk.ts`), passed into
    `HeadroomStatusBar`'s constructor at activation.
  - Headroom: `computeState()`'s `not-initialized` (config genuinely
    missing — e.g. `mode=remote` with empty `remoteUrl`, the only case
    where `!base`) or `error` (health check fails though configured —
    proxy down/crashed) states. Both are real, non-transient problems
    by the time `refresh()` runs, not "still starting up" — `ensureRunning`
    already attempted a spawn once during `activate()` before the status
    bar's own polling begins.
  - When broken: `item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')`
    (the only background colors VS Code honors on status bar items are
    `errorBackground`/`warningBackground` — anything else is silently
    ignored). The click target itself doesn't change with broken state
    (see below) — both Dashboard and Settings are always one click away
    either way, so there's no need to switch the command based on state.
- **Content** (VS Code status bar items can't render real
  charts/canvas — text + Codicons only):
  - Bar text: compact numeric summary (e.g. tokens/€ saved), optionally
    followed by a Unicode block sparkline (▁▂▃▄▅▆▇█) built from recent
    savings data points — cheap inline "mini graph", no dependencies.
  - Tooltip (`MarkdownString`): richer breakdown on hover — e.g. RTK
    vs Headroom split, today vs all-time — still no real chart, just
    markdown text/table.
  - The dashboard's own charts are **not** reimplemented in the status
    bar — that's what Headroom's own `/dashboard` is for, opened in an
    embedded VS Code tab on click (see below). No chart-drawing code
    lives in this extension.
- Click → `easy-headroom.statusBarMenu` (`commands.ts`) shows a
  `showQuickPick` with two entries, **Open Dashboard** / **Open
  Settings**, rather than jumping straight to one or the other —
  deliberate, since users otherwise have to hunt for an extension's
  settings via the gear icon/Command Palette. Picking Dashboard opens
  it **inside VS Code**, as a `WebviewPanel` tab (no address
  bar/toolbar — that's just how webviews render, no extra flag
  needed), rather than the system browser.
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

- **Tab bar only when both are available.** `showTabs = headroomAvailable
  && rtkAvailable` gates the entire `#tabbar` block in
  `renderDashboardHtml()`. If only one source is configured, that
  single view renders directly with no switcher UI at all — there's
  nothing to switch between. This is deliberate, not an oversight: a
  tab bar with one dead/greyed-out button would be worse than no tab
  bar.
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
    — QuickPick of detected versions (see "Versioning" under each
    install section), writes the choice to the matching
    `pinnedVersion` setting, then reinstalls.
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
  `~/.claude/settings.json`, delete the downloaded RTK binary and the
  Headroom venv from `globalStorageUri`, stop the shared proxy daemon
  if running.

### Security / practices to follow

- Never log or transmit the actual content of shell commands beyond
  what RTK already stores natively (the reporting endpoint only relays
  what `rtk gain --format json` would expose anyway).
- `headroom.proxyToken` is always sent as an `X-Headroom-Proxy-Token`
  header (never a query string, never `Authorization`), from three
  places, all `remote` mode only:
  - the RTK ingest and checkpoint endpoints (`rtkReporting.ts`);
  - every proxied Claude Code request, via the `ANTHROPIC_CUSTOM_HEADERS`
    env var (Claude Code's own mechanism for attaching extra headers to
    outbound API requests), set through `applyProjectEnv` in
    `daemon.ts`'s `applyEnvironment`;
  - the dashboard webview's traffic, attached by the extension's own
    local reverse proxy (`startDashboardProxy` in `commands.ts`) on
    every request it forwards — the one place this can be done for
    the dashboard, since neither a plain browser nor Headroom's own
    client-rendered dashboard JS can set a custom header on themselves.

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

## Guiding principle for Claude Code

Always keep RTK and Headroom as two strictly independent layers in the
codebase (no function should assume one implies the other) — this is
the principle that emerged from all the debugging that led to this
project, and it must remain true in the implementation. The same
independence applies across RTK's agents: no function should assume
that because one agent is configured/working, another is too (see
"Multi-agent scope (V1)").