# cc-statusline

A custom [Claude Code](https://claude.com/claude-code) statusline: no plugin dependencies, just a Node script Claude Code invokes and pipes JSON into on every render.

Shows, per column (each toggleable in `config.jsonc`):

- **5h Usage / 7d Usage** — two stacked bars per window: quota used (top), and how far into the window you are (bottom), the second bar coloured by *pace* rather than raw elapsed time — red/yellow if usage is running ahead of the clock, i.e. on track to exhaust the window before it resets.
- **5h Burn / 7d Burn (all)** — account-wide (all terminals combined; Anthropic's usage API has no per-terminal breakdown) burn rate in %/hr, last-hour and trailing-week average, each coloured against the flat pace that would exactly exhaust the window at reset.
- **This Terminal** — this session's own $/hr, lifetime-averaged. A different unit than the account-wide Burn columns (dollars vs. %-of-quota — there's no published conversion between them), but useful for spotting which of several concurrent terminals is the heavy one.
- **Context** — context-window usage, small bar + percentage.
- Plus the usual: Model, Version (with last-fetch time), git branch/dirty state, session cost/duration, token counts, running-agent tree, todo progress.

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI, already logged in — this script reads the same OAuth credentials Claude Code itself uses (from `~/.claude/.credentials.json`, or the macOS Keychain as a fallback), so there's no separate auth step.
- Node.js (any reasonably recent version). No `npm install` needed — the script uses only Node's built-in modules, zero third-party dependencies.
- macOS or Linux. (The Keychain fallback is macOS-only, but the primary credentials-file path works anywhere Claude Code runs.)

## Installation

1. Clone this repo into `~/.claude/hud`:
   ```sh
   git clone https://github.com/jonobri/cc-statusline.git ~/.claude/hud
   ```
2. Point Claude Code at it — add this to `~/.claude/settings.json` (merge it in if the file already has other keys):
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/hud/metricc-cc-statusbar.mjs",
       "padding": 0
     }
   }
   ```
3. Start a new Claude Code session (or restart your current one) — the statusline should appear at the bottom on the next render. If it just says `[HUD] waiting for data...`, that's normal for the very first render; it resolves as soon as Claude Code sends its first status payload.
4. (Optional) edit `config.jsonc` to toggle columns on/off, or switch `layout` between `"vertical"` (stacked label-over-value, wraps onto extra rows) and `"horizontal"` (`label value` cells packed left to right). The script falls back to sensible defaults if this file is missing entirely, so this step can be skipped.

### Updating

```sh
cd ~/.claude/hud && git pull
```

Your local `config.jsonc` edits will conflict with upstream changes to that same file on `git pull` if both touched it — resolve as you would any other git conflict, or `git stash` your local edits first if you'd rather reapply them after.

## How the burn-rate math works

The Anthropic usage API only reports a point-in-time utilization %, not a trend, so this script keeps its own history: every real (non-cached) fetch appends a `{ts, fiveHour, fiveHourResets, sevenDay, sevenDayResets}` row to `.usage-history.jsonl` (gitignored — machine-local runtime state, not config), trimmed to 8 days.

Burn rate is computed from that log, anchored on `resets_at − window_length` (known exactly from the live API — the rate limiter always starts a window at 0%) rather than guessing the window's start from whatever's in the log. That anchor is what keeps the numbers correct from the very first render after the log exists, instead of only becoming trustworthy after a full window's worth of local logging has accumulated.

Reset-boundary detection skips any interval that crosses a real window reset (so the % dropping back to ~0 doesn't read as a negative rate), and separately drops any sample with a missing/zero `resetsKey` outright — Anthropic's API has been observed to emit one transient garbage sample right at a boundary, and including it corrupts the reset-detection on both of its neighbouring intervals.

## Caveats

The 5h/7d Usage bars and Burn columns rely on `/api/oauth/usage` and the token refresh at `/v1/oauth/token` (`platform.claude.com`) — the same endpoints Claude Code's own CLI uses internally, reached with the same OAuth client ID (a public, native-app client identifier; no secret is stored anywhere in this script). Neither is a documented, stable public API, so Anthropic could change or restrict them without notice, which would silently degrade those columns to `N/A` / `warming up` (everything else — Context, Model, git branch, session cost/duration, token counts — comes from Claude Code's own stdin payload and is unaffected either way).

## Files

- `metricc-cc-statusbar.mjs` — the script.
- `config.jsonc` — column toggles, layout, max width (JSONC — `//` comments allowed).
- `.gitignore` — excludes the runtime cache/history/lock files this script creates next to itself at runtime.
