# cc-statusline

A custom [Claude Code](https://claude.com/claude-code) statusline: no plugin dependencies, just a Node script Claude Code invokes and pipes JSON into on every render.

Shows, per column (each toggleable in `config.jsonc`):

- **5h Usage / 7d Usage** — two stacked bars per window: quota used (top), and how far into the window you are (bottom), the second bar coloured by *pace* rather than raw elapsed time — red/yellow if usage is running ahead of the clock, i.e. on track to exhaust the window before it resets.
- **5h Burn / 7d Burn (all)** — account-wide (all terminals combined; Anthropic's usage API has no per-terminal breakdown) burn rate in %/hr, last-hour and trailing-week average, each coloured against the flat pace that would exactly exhaust the window at reset.
- **This Terminal** — this session's own $/hr, lifetime-averaged. A different unit than the account-wide Burn columns (dollars vs. %-of-quota — there's no published conversion between them), but useful for spotting which of several concurrent terminals is the heavy one.
- **Context** — context-window usage, small bar + percentage.
- Plus the usual: Model, Version (with last-fetch time), git branch/dirty state, session cost/duration, token counts, running-agent tree, todo progress.

## Setup

1. Copy `metricc-cc-statusbar.mjs` and `config.jsonc` to `~/.claude/hud/`.
2. Point Claude Code at it in `~/.claude/settings.json`:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/hud/metricc-cc-statusbar.mjs",
       "padding": 0
     }
   }
   ```
3. Edit `config.jsonc` to toggle columns / switch `layout` between `"vertical"` (stacked label-over-value, wraps onto extra rows) and `"horizontal"` (`label value` cells packed left to right).

## How the burn-rate math works

The Anthropic usage API only reports a point-in-time utilization %, not a trend, so this script keeps its own history: every real (non-cached) fetch appends a `{ts, fiveHour, fiveHourResets, sevenDay, sevenDayResets}` row to `.usage-history.jsonl` (gitignored — machine-local runtime state, not config), trimmed to 8 days.

Burn rate is computed from that log, anchored on `resets_at − window_length` (known exactly from the live API — the rate limiter always starts a window at 0%) rather than guessing the window's start from whatever's in the log. That anchor is what keeps the numbers correct from the very first render after the log exists, instead of only becoming trustworthy after a full window's worth of local logging has accumulated.

Reset-boundary detection skips any interval that crosses a real window reset (so the % dropping back to ~0 doesn't read as a negative rate), and separately drops any sample with a missing/zero `resetsKey` outright — Anthropic's API has been observed to emit one transient garbage sample right at a boundary, and including it corrupts the reset-detection on both of its neighbouring intervals.

## Files

- `metricc-cc-statusbar.mjs` — the script.
- `config.jsonc` — column toggles, layout, max width (JSONC — `//` comments allowed).
- `.gitignore` — excludes the runtime cache/history/lock files this script creates next to itself at runtime.
