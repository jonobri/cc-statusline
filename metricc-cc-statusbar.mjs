#!/usr/bin/env node
/**
 * Custom HUD - Standalone Claude Code Statusline
 * No plugin dependencies. Shows: rate limits, session time, context %, agents.
 *
 * Data sources:
 * - stdin JSON from Claude Code (context window, model, transcript path)
 * - Anthropic OAuth API (5h/7d rate limits) — cached 60s
 * - Transcript JSONL (session start, running agents)
 */

import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, mkdirSync, createReadStream, renameSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import https from "node:https";
import { execSync } from "node:child_process";
import tty from "node:tty";

// ── Constants ──────────────────────────────────────────────────────────────────
// 5min, not 60s. Rate-limit utilisation is a slow gauge — a 5-hour window moves
// ~1.7% in five minutes — so a shorter TTL buys no real freshness and costs 5x
// the API calls. Combined with the single-flight lock this is 12 calls/hour
// regardless of how many agent terminals are open.
const CACHE_TTL_MS = 300_000;
// Back OFF on failure, don't lean in. The usual failure here is HTTP 429 from
// several agent terminals polling at once; retrying 4x faster than the success
// path is what keeps the rate limit tripped. Longer than CACHE_TTL_MS on purpose.
const CACHE_TTL_FAILURE_MS = 120_000; // 2min on failure
const API_TIMEOUT_MS = 8000;
const MAX_TAIL_BYTES = 512 * 1024;    // 500KB tail read for large transcripts
const MAX_AGENT_MAP = 100;
const STALE_AGENT_MS = 30 * 60_000;   // 30 min = stale agent
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const VERSION_CACHE_TTL_MS = 3_600_000; // 1hr cache for npm version check

const FIVE_HOUR_MS = 5 * 3_600_000;
const SEVEN_DAY_MS = 7 * 24 * 3_600_000;
// Burn-rate history: one row per real (non-cached) usage fetch, i.e. one per
// CACHE_TTL_MS tick regardless of how many terminals are open (single-flight
// lock). Trimmed to this age on every write, so the file stays a few hundred KB.
const HISTORY_MAX_AGE_MS = 8 * 24 * 3_600_000;

const ALL_COLUMNS = [
  // Standard
  "5h Usage", "7d Usage", "Context", "Model", "Version",
  // Burn rate — 5h/7d Burn are account-wide (Anthropic's usage API has no
  // per-terminal breakdown); This Terminal is this session's own local rate.
  "5h Burn", "7d Burn", "This Terminal", "Peers",
  // Session
  "Session", "Changes", "Directory", "Branch", "Cost",
  // Advanced
  "Tokens", "Output Tokens", "Cache", "API Time", "5h Reset", "7d Reset",
];

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".claude", "hud", "config.jsonc");
const CACHE_PATH = join(HOME, ".claude", "hud", ".usage-cache.json");
const HISTORY_PATH = join(HOME, ".claude", "hud", ".usage-history.jsonl");
const VERSION_CACHE_PATH = join(HOME, ".claude", "hud", ".version-cache.json");
const CRED_PATH = join(HOME, ".claude", ".credentials.json");

// ── ANSI Colors ────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;5;150;105m",      // Tailwind Emerald-600 (#059669)
  yellow: "\x1b[38;2;217;119;6m",    // Tailwind Amber-600 (#d97706)
  red: "\x1b[38;2;220;38;38m",       // Tailwind Red-600 (#dc2626)
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  // Tailwind Slate-300 (#cbd5e1) for data values — brightened for readability
  slate600: "\x1b[38;2;203;213;225m",
  // Tailwind Slate-400 (#94a3b8) for labels — brightened for readability
  slate700: "\x1b[38;2;148;163;184m",
  slate700bold: "\x1b[1;38;2;148;163;184m",
  // Tailwind Slate-400 (#94a3b8) for separators and labels — brightened for readability
  slate800: "\x1b[38;2;148;163;184m",
  slate800bold: "\x1b[1;38;2;148;163;184m",
};

// ── Config ─────────────────────────────────────────────────────────────────────
// Config file: ~/.claude/hud/config.json (supports // comments)
// Toggle columns with true/false. Missing keys default to their section default.
function parseJsonc(text) {
  // Strip both full-line and inline comments, then trailing commas
  const stripped = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/.*/g, (m, str) => str || "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

const SECTION_DEFAULTS = {
  // Standard: on by default
  "5h Usage": true, "7d Usage": true, "Context": true, "Model": true, "Version": true,
  // Burn rate: on by default
  "5h Burn": true, "7d Burn": true, "This Terminal": true, "Peers": true,
  // Session: off by default
  "Session": false, "Changes": false, "Directory": false, "Branch": false, "Cost": false,
  // Advanced: off by default
  "Tokens": false, "Output Tokens": false, "Cache": false, "API Time": false, "5h Reset": false, "7d Reset": false,
};

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical", maxWidth: 0 };
    }
    const cfg = parseJsonc(readFileSync(CONFIG_PATH, "utf-8"));
    const enabled = ALL_COLUMNS.filter((id) => {
      if (id in cfg) return cfg[id] !== false;
      return SECTION_DEFAULTS[id] !== false;
    });
    const layout = cfg.layout === "horizontal" ? "horizontal" : "vertical";
    const maxWidth = Number.isFinite(Number(cfg.maxWidth)) ? Number(cfg.maxWidth) : 0;
    return { columns: enabled.length > 0 ? enabled : ALL_COLUMNS, layout, maxWidth };
  } catch {
    return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical" };
  }
}

// ── Stdin Parser ───────────────────────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = chunks.join("");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getContextPercent(stdin) {
  const pct = stdin.context_window?.used_percentage;
  if (typeof pct === "number" && !Number.isNaN(pct)) {
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
  const size = stdin.context_window?.context_window_size;
  if (!size || size <= 0) return 0;
  const usage = stdin.context_window?.current_usage;
  const total = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  return Math.min(100, Math.round((total / size) * 100));
}

function getModelId(stdin) {
  // Claude Code sends the human-friendly name directly — prefer it over guessing from the id.
  if (stdin.model?.display_name) return stdin.model.display_name;
  const id = stdin.model?.id ?? "unknown";
  // No whitelist of family names: split into name words vs version numbers, whatever they are.
  // "claude-opus-4-6" → "Opus 4.6", "claude-encyclopedia-5" → "Encyclopedia 5", "claude-haiku-4-5-20251001" → "Haiku 4.5"
  const parts = id.split("-").filter((part) => part !== "claude" && !/^\d{8}$/.test(part)); // drop date stamps too
  const name = parts.filter((part) => !/^\d+$/.test(part)).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  if (!name) return id;
  return version ? `${name} ${version}` : name;
}

function getVersion(stdin) {
  return stdin.version ?? null;
}

// ── Git Branch ─────────────────────────────────────────────────────────────────
function getGitBranch(cwd) {
  if (!cwd) return null;
  try {
    const branch = execSync("git --no-optional-locks rev-parse --abbrev-ref HEAD", {
      cwd, timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch || branch === "HEAD") return null;
    let dirty = false;
    try {
      const status = execSync("git --no-optional-locks status --porcelain", {
        cwd, timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      });
      dirty = status.trim().length > 0;
    } catch { /* ignore */ }
    return { branch, dirty };
  } catch {
    return null;
  }
}

// ── Concurrency ───────────────────────────────────────────────────────────────
// Every agent terminal runs its own copy of this status line. With ~9 sessions
// they all expire the 60s usage cache at the same moment and stampede: each one
// refreshes the OAuth token with the SAME refresh token, which rotates on use,
// so one wins and the rest get invalid_grant and render N/A. The losers then
// write error:true over the shared cache, clobbering the winner's good data.
// Single-flight the network work, and make every shared-file write atomic so a
// concurrent reader can never see a half-written file.
const LOCK_PATH = join(HOME, ".claude", "hud", ".usage.lock");
const LOCK_STALE_MS = 30_000;

function acquireLock() {
  try {
    const st = statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      try { unlinkSync(LOCK_PATH); } catch { /* raced */ }
    } else {
      return false; // someone else is fetching; serve what we have
    }
  } catch { /* no lock present */ }
  try {
    closeSync(openSync(LOCK_PATH, "wx")); // exclusive create == the lock
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

// rename(2) is atomic within a filesystem, so readers see old or new, never torn.
function writeFileAtomic(path, contents, mode) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// ── Usage API (Anthropic OAuth) ────────────────────────────────────────────────
function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    // Reconstitute Date objects lost during JSON serialization
    if (cache?.data) {
      if (cache.data.fiveHourResets) cache.data.fiveHourResets = new Date(cache.data.fiveHourResets);
      if (cache.data.sevenDayResets) cache.data.sevenDayResets = new Date(cache.data.sevenDayResets);
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCache(data, error = false) {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data, error }));
  } catch { /* ignore */ }
}

function isCacheValid(cache) {
  const ttl = cache.error ? CACHE_TTL_FAILURE_MS : CACHE_TTL_MS;
  return Date.now() - cache.timestamp < ttl;
}

// ── Burn-rate history ────────────────────────────────────────────────────────
// Append-only log of {ts, fiveHour, fiveHourResets, sevenDay, sevenDayResets}
// snapshots, one per real API fetch. The usage API only ever reports current
// utilization, not a trend — this log is what makes "%/hr" computable at all.
function readHistory() {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const lines = readFileSync(HISTORY_PATH, "utf-8").split("\n");
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.ts === "number") rows.push(row);
      } catch { /* skip corrupt line */ }
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows;
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  try {
    const dir = dirname(HISTORY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    const rows = readHistory().filter((r) => r.ts >= cutoff);
    rows.push(entry);
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileAtomic(HISTORY_PATH, body);
  } catch { /* best-effort; a gap in history just degrades burn-rate stats */ }
}

function getCredentials() {
  // Primary: read from JSON file (all platforms)
  try {
    if (existsSync(CRED_PATH)) {
      const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
      const creds = parsed.claudeAiOauth || parsed;
      if (creds.accessToken) {
        return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
      }
    }
  } catch { /* */ }

  // Fallback: macOS Keychain only
  if (process.platform === "darwin") {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        timeout: 3000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const creds = parsed.claudeAiOauth || parsed;
        if (creds.accessToken) {
          return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
        }
      }
    } catch { /* Keychain entry doesn't exist or parse failed */ }
  }

  return null;
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();
    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const p = JSON.parse(data);
            if (p.access_token) {
              resolve({ accessToken: p.access_token, refreshToken: p.refresh_token || refreshToken, expiresAt: p.expires_in ? Date.now() + p.expires_in * 1000 : p.expires_at });
              return;
            }
          } catch { /* */ }
        }
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function writeBackCredentials(creds) {
  try {
    if (!existsSync(CRED_PATH)) return;
    const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
    const target = parsed.claudeAiOauth || parsed;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    // 0600 explicitly: the temp file is a fresh inode, so it would otherwise be
    // created at the default umask and land world-readable after the rename.
    writeFileAtomic(CRED_PATH, JSON.stringify(parsed, null, 2), 0o600);
  } catch { /* */ }
}

async function getUsage() {
  const cache = readCache();
  // fetchedAt travels with the data so render() can show how stale the usage%
  // snapshot is — the bars' own countdown is always live (computed from an
  // absolute reset time at render time), but the % itself is this cached
  // value, up to CACHE_TTL_MS (or CACHE_TTL_FAILURE_MS while erroring) old.
  if (cache && isCacheValid(cache)) return { ...cache.data, fetchedAt: cache.timestamp };

  // Stale data beats N/A: a rate limit that was 75% a minute ago is still
  // roughly 75% now, whereas a blank column tells you nothing.
  const lastGood = cache?.data ?? null;
  const lastGoodOut = lastGood ? { ...lastGood, fetchedAt: cache?.timestamp ?? null } : null;

  // Only one process per machine does the refresh/fetch. Everyone else keeps
  // rendering the previous value rather than invalidating each other's tokens.
  if (!acquireLock()) return lastGoodOut;

  try {
    let creds = getCredentials();
    if (!creds) { writeCache(lastGood, true); return lastGoodOut; }

    // Refresh if expired
    if (creds.expiresAt && creds.expiresAt <= Date.now()) {
      if (creds.refreshToken) {
        const refreshed = await refreshAccessToken(creds.refreshToken);
        if (refreshed) {
          creds = { ...creds, ...refreshed };
          writeBackCredentials(creds);
        } else {
          writeCache(lastGood, true);
          return lastGoodOut;
        }
      } else {
        writeCache(lastGood, true);
        return lastGoodOut;
      }
    }

    const resp = await fetchUsage(creds.accessToken);
    if (!resp) { writeCache(lastGood, true); return lastGoodOut; }

    const clamp = (v) => (v == null || !isFinite(v)) ? 0 : Math.max(0, Math.min(100, v));
    const parseDate = (s) => { try { const d = new Date(s); return isNaN(d.getTime()) ? null : d; } catch { return null; } };

    const data = {
      fiveHour: clamp(resp.five_hour?.utilization),
      fiveHourResets: parseDate(resp.five_hour?.resets_at),
      sevenDay: clamp(resp.seven_day?.utilization),
      sevenDayResets: parseDate(resp.seven_day?.resets_at),
    };
    const fetchedAt = Date.now();
    writeCache(data);
    appendHistory({
      ts: fetchedAt,
      fiveHour: data.fiveHour,
      fiveHourResets: data.fiveHourResets ? data.fiveHourResets.getTime() : null,
      sevenDay: data.sevenDay,
      sevenDayResets: data.sevenDayResets ? data.sevenDayResets.getTime() : null,
    });
    return { ...data, fetchedAt };
  } finally {
    releaseLock();
  }
}

// ── Version Check (npm registry) ─────────────────────────────────────────────
function readVersionCache() {
  try {
    if (!existsSync(VERSION_CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(VERSION_CACHE_PATH, "utf-8"));
    if (Date.now() - cache.timestamp < VERSION_CACHE_TTL_MS) return cache.data;
    return null;
  } catch {
    return null;
  }
}

function writeVersionCache(data) {
  try {
    const dir = dirname(VERSION_CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(VERSION_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch { /* ignore */ }
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "registry.npmjs.org",
      path: "/@anthropic-ai/claude-code/latest",
      method: "GET",
      headers: { Accept: "application/json" },
      timeout: 3000,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).version || null); } catch { resolve(null); }
        } else resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getLatestVersion() {
  const cached = readVersionCache();
  if (cached) return cached;
  const latest = await fetchLatestVersion();
  if (latest) writeVersionCache(latest);
  return latest;
}

// ── Transcript Parser ──────────────────────────────────────────────────────────
function readTailLines(filePath, fileSize, maxBytes) {
  const start = Math.max(0, fileSize - maxBytes);
  const len = fileSize - start;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(len);
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0 && lines.length > 0) lines.shift(); // discard partial first line
  return lines;
}

async function parseTranscript(transcriptPath) {
  const result = { sessionStart: null, agents: [], todos: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const agentMap = new Map();
  const bgMap = new Map();
  let latestTodos = [];
  // This harness creates/updates tasks one at a time (TaskCreate/TaskUpdate),
  // not as a single batched "todos" array like legacy TodoWrite. Track them
  // individually: TaskCreate's tool_result reveals the real numeric taskId
  // ("Task #3 created successfully: ..."), which TaskUpdate then references.
  const todoMap = new Map();
  const pendingTaskCreates = new Map();

  function processLine(line) {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
    if (!result.sessionStart && entry.timestamp) result.sessionStart = ts;

    const content = entry.message?.content;
    if (!content || !Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_use" && block.id && block.name) {
        if (block.name === "Task" || block.name === "proxy_Task" || block.name === "Agent") {
          const input = block.input;
          if (agentMap.size >= MAX_AGENT_MAP) {
            // Evict oldest completed
            let oldest = null, oldestT = Infinity;
            for (const [id, a] of agentMap) {
              if (a.status === "completed" && a.startTime.getTime() < oldestT) {
                oldestT = a.startTime.getTime();
                oldest = id;
              }
            }
            if (oldest) agentMap.delete(oldest);
          }
          agentMap.set(block.id, {
            id: block.id,
            type: input?.subagent_type ?? "unknown",
            model: input?.model,
            description: input?.description ?? "",
            status: "running",
            startTime: ts,
          });
        }
        if (block.name === "TodoWrite") {
          const input = block.input;
          if (input?.todos && Array.isArray(input.todos)) {
            latestTodos = input.todos.map((t) => ({ content: t.content, status: t.status }));
          }
        }
        if (block.name === "TaskCreate") {
          pendingTaskCreates.set(block.id, block.input?.subject ?? "");
        }
        if (block.name === "TaskUpdate") {
          const input = block.input;
          const taskId = input?.taskId;
          if (taskId) {
            if (input.status === "deleted") {
              todoMap.delete(taskId);
            } else {
              const existing = todoMap.get(taskId);
              if (existing) existing.status = input.status ?? existing.status;
              else todoMap.set(taskId, { content: "", status: input.status ?? "pending" });
            }
          }
        }
      }

      if (block.type === "tool_result" && block.tool_use_id) {
        const agent = agentMap.get(block.tool_use_id);
        if (agent) {
          const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : "");
          if (text.includes("Async agent launched")) {
            const m = text.match(/agentId:\s*([a-zA-Z0-9]+)/);
            if (m) bgMap.set(m[1], block.tool_use_id);
          } else {
            agent.status = "completed";
            agent.endTime = ts;
          }
        }
        if (pendingTaskCreates.has(block.tool_use_id)) {
          const subject = pendingTaskCreates.get(block.tool_use_id);
          pendingTaskCreates.delete(block.tool_use_id);
          const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : "");
          const m = text.match(/Task #(\d+) created/);
          if (m) todoMap.set(m[1], { content: subject, status: "pending" });
        }
        // Check TaskOutput completion
        if (block.content) {
          const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : "");
          const tidM = text.match(/<task[_-]id>([^<]+)<\/task[_-]id>/);
          const stM = text.match(/<status>([^<]+)<\/status>/);
          if (tidM && stM && stM[1] === "completed") {
            const origId = bgMap.get(tidM[1]);
            if (origId) {
              const bg = agentMap.get(origId);
              if (bg && bg.status === "running") { bg.status = "completed"; bg.endTime = ts; }
            }
          }
        }
      }
    }
  }

  try {
    const stat = statSync(transcriptPath);
    if (stat.size > MAX_TAIL_BYTES) {
      // For session start, read just the first line
      const fd = openSync(transcriptPath, "r");
      const firstBuf = Buffer.alloc(Math.min(4096, stat.size));
      try { readSync(fd, firstBuf, 0, firstBuf.length, 0); } finally { closeSync(fd); }
      const firstLine = firstBuf.toString("utf8").split("\n")[0];
      if (firstLine.trim()) {
        try {
          const e = JSON.parse(firstLine);
          if (e.timestamp) result.sessionStart = new Date(e.timestamp);
        } catch { /* */ }
      }
      // Then tail-read for agents
      for (const line of readTailLines(transcriptPath, stat.size, MAX_TAIL_BYTES)) processLine(line);
    } else {
      const stream = createReadStream(transcriptPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) processLine(line);
    }
  } catch { /* partial results */ }

  // Mark stale agents
  const now = Date.now();
  for (const a of agentMap.values()) {
    if (a.status === "running" && now - a.startTime.getTime() > STALE_AGENT_MS) {
      a.status = "completed";
    }
  }

  const running = [...agentMap.values()].filter((a) => a.status === "running");
  const completed = [...agentMap.values()].filter((a) => a.status === "completed");
  result.agents = [...running, ...completed.slice(-(10 - running.length))].slice(0, 10);
  result.todos = todoMap.size > 0 ? [...todoMap.values()] : latestTodos;
  return result;
}

// ── Burn Rate ──────────────────────────────────────────────────────────────────
// A window reset (5h fires ~5x/day, 7d weekly) drops utilization back near 0
// mid-series. A naive delta across that boundary reads as a nonsense negative
// rate, so every rate calc here has to recognise and skip reset boundaries.
// Two independent signals catch it: the reset deadline jumping forward by
// close to a full window (a real reset) OR the percentage dropping. resets_at
// itself is NOT a stable stored value — the live API jitters it by a few
// hundred ms between consecutive calls (observed empirically), so comparing
// for exact equality flags nearly every sample pair as a false reset and
// burn rate never leaves "warming up". RESET_JITTER_MS is comfortably above
// that noise floor and orders of magnitude below a real reset's jump.
const RESET_JITTER_MS = 60_000;
function isResetBoundary(prev, curr, key, resetsKey) {
  const prevReset = prev[resetsKey], currReset = curr[resetsKey];
  if (prevReset != null && currReset != null && Math.abs(currReset - prevReset) > RESET_JITTER_MS) return true;
  if (curr[key] < prev[key] - 1) return true; // 1pt slack for rounding noise
  return false;
}

// %/hr over [sinceTs, now], skipping any interval that crosses a reset and
// prorating the one interval that straddles `sinceTs` so partial windows
// (e.g. "last hour" when the log only starts 40min back) aren't overcounted.
function burnRate(history, key, resetsKey, sinceTs, now) {
  const pts = history.filter((h) => h.ts <= now && h.ts >= sinceTs - 15 * 60_000);
  if (pts.length < 2) return null;
  let sumDelta = 0, sumHours = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], curr = pts[i];
    if (isResetBoundary(prev, curr, key, resetsKey)) continue;
    const intervalStart = Math.max(prev.ts, sinceTs);
    const hours = (curr.ts - intervalStart) / 3_600_000;
    if (hours <= 0) continue;
    const fullHours = (curr.ts - prev.ts) / 3_600_000;
    const fraction = fullHours > 0 ? hours / fullHours : 1;
    sumDelta += (curr[key] - prev[key]) * fraction;
    sumHours += hours;
  }
  if (sumHours < 2 / 60) return null; // need >=2min of real coverage
  return sumDelta / sumHours;
}

function budgetRateFor(windowMs) {
  return 100 / (windowMs / 3_600_000); // flat %/hr that exactly exhausts the window at reset
}

// currentPct/resetDate come straight from the live API, independent of how
// much local history has accumulated — anchoring on them (rather than
// guessing the window's start from whatever's in the log) is what keeps
// windowAvg correct from the very first render after this log is created,
// instead of only becoming trustworthy after a full window's worth of
// logging has passed.
function computeBurnStats(history, key, resetsKey, windowMs, resetDate, currentPct, now) {
  const trueWindowStart = resetDate ? resetDate.getTime() - windowMs : null;
  const validAnchor = trueWindowStart != null && trueWindowStart <= now && typeof currentPct === "number";

  // Anthropic's usage API has been observed to emit one transient sample
  // right at a window boundary with resetsKey missing or 0 (not a real reset
  // target — e.g. {fiveHour:0, fiveHourResets:0}). Exclude those outright
  // rather than let them into the reset-boundary walk below: a bogus
  // resetsKey looks like a huge jump on BOTH sides of that sample, so it was
  // flagging its two real neighbouring intervals as resets too and wiping out
  // otherwise-clean same-window data.
  const cleanHistory = (history || []).filter((h) => typeof h[key] === "number" && h[resetsKey] != null && h[resetsKey] > 0);

  // The rate limiter resets every window to 0%, so (windowStart, 0%) is a
  // known-true data point, not a guess — insert it whenever it isn't already
  // there. This is what fixes "99% used but 'win' says 2%/hr": that 2%/hr was
  // averaged only over the freshly-started log's tail, oblivious to the hours
  // the window had already been running beforehand. The array can hold
  // entries from a still-earlier, already-reset window with a SMALLER ts than
  // trueWindowStart, so this must re-sort rather than assume prepending is
  // correct — checking "does the earliest logged row reach back this far"
  // would wrongly match against that older window's data and skip inserting.
  let series = cleanHistory;
  if (validAnchor && !series.some((h) => h.ts === trueWindowStart)) {
    series = [...series, { ts: trueWindowStart, [key]: 0, [resetsKey]: resetDate.getTime() }].sort((a, b) => a.ts - b.ts);
  }
  if (series.length < 2) return null;

  return {
    lastHour: burnRate(series, key, resetsKey, now - 3_600_000, now),
    weekAvg: burnRate(series, key, resetsKey, now - 7 * 24 * 3_600_000, now),
    budgetRate: budgetRateFor(windowMs),
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function colorForPercent(pct, warnAt = 70, critAt = 85) {
  if (pct >= critAt) return c.red;
  if (pct >= warnAt) return c.yellow;
  return c.green;
}

function drawBar(pct, width, color) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `${color}[${"█".repeat(filled)}${"░".repeat(empty)}]${c.reset}`;
}

function formatClock(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// The bars' own reset countdown is always accurate (computed from an absolute
// timestamp at render time); the usage% feeding them is a cached snapshot,
// stale by however long since this fetch. Colour flags when that's no longer
// "just normal 5min polling lag" but a sign the live fetch has been failing.
function updatedLine(fetchedAt) {
  if (!fetchedAt) return null;
  const ageMs = Date.now() - fetchedAt;
  const ageColor = ageMs > CACHE_TTL_MS * 3 ? c.red : ageMs > CACHE_TTL_MS * 1.5 ? c.yellow : c.slate600;
  return `${ageColor}Updated ${formatClock(fetchedAt)}${c.reset}`;
}

function remainingShort(resetDate) {
  if (!resetDate) return null;
  const d = resetDate instanceof Date ? resetDate : new Date(resetDate);
  if (isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `~${h}h` : `${m}m`;
}

function formatResetTime(resetDate) {
  const short = remainingShort(resetDate);
  return short ? `${c.slate600}(${short})${c.reset}` : "";
}

// Two bars per window, stacked: quota used (standard traffic-light colour) on
// top, and time elapsed in the window underneath — but coloured by PACE, not
// by elapsed% itself. If usage% is running ahead of elapsed%, you'll hit the
// cap before it resets; that gap, not either raw number alone, is what the
// elapsed bar's colour encodes. This is the "90% used at 1hr remaining means
// less than you'd think" comparison made visual: read both bars' fill level
// stacked on top of each other. Returns an array of 1-2 lines (2 whenever the
// reset time is known) for the caller to render one-per-row under the label.
function usageBarValue(pct, resetDate, windowMs) {
  const usageColor = colorForPercent(pct, 60, 80);
  // Width 6 — one wider than the Context bar (5, line ~1004). Matched
  // exactly at first but read one char too cramped at this size.
  const bar1 = drawBar(pct, 6, usageColor);
  const roundedPct = Math.round(pct);
  const line1 = `${bar1} ${c.slate600}${roundedPct}%${c.reset}`;
  const msUntilReset = resetDate ? resetDate.getTime() - Date.now() : null;
  const validWindow = msUntilReset != null && msUntilReset > 0 && msUntilReset <= windowMs;
  if (!validWindow) return [line1];
  const elapsedPct = Math.max(0, Math.min(100, ((windowMs - msUntilReset) / windowMs) * 100));
  const paceDelta = pct - elapsedPct;
  const paceColor = paceDelta >= 15 ? c.red : paceDelta >= 5 ? c.yellow : c.green;
  const bar2 = drawBar(elapsedPct, 6, paceColor);
  const remaining = remainingShort(resetDate) ?? "now";
  const line2 = `${bar2} ${paceColor}${remaining}${c.reset}`;
  return [line1, line2];
}

// Stacked one metric per line — last hour, trailing-week avg — each coloured
// against its own comparison to the flat pace needed to exactly exhaust the
// window at reset (100 / window-hours). Per-row colour (rather than one
// colour for the whole block) is what stacking buys here: a red "1h" next to
// a green "wk" reads as "you just spiked", not "you're in trouble". No "win"
// (current-window average) row — the Usage bars' pace-coloured elapsed bar
// already shows that same comparison, so a third row here would be redundant
// rather than additive.
function burnValue(stats) {
  if (!stats) return [`${c.slate600}warming up${c.reset}`];
  const dp = stats.budgetRate < 1 ? 2 : 1;
  const fmt = (r) => (r == null ? "–" : r.toFixed(dp));
  const rowColor = (r) => r == null ? c.slate600
    : r >= stats.budgetRate * 1.15 ? c.red
    : r >= stats.budgetRate * 0.9 ? c.yellow
    : c.green;
  // "%/hr": percentage-points of the quota window consumed per hour — e.g.
  // 2.2%/hr against a 20%/hr budget means "at this rate, ~45hrs to exhaust a
  // window that only lasts 5", i.e. comfortably sustainable.
  const row = (label, r) => `${c.slate600}${label.padEnd(4)}${c.reset}${rowColor(r)}${fmt(r)}%${c.reset}${c.slate600}/hr${c.reset}`;
  return [row("1h", stats.lastHour), row("wk", stats.weekAvg)];
}

// This session's own $/hr, lifetime-averaged (Claude Code has no per-minute
// cost history to draw a "last hour" figure from locally, unlike the
// account-wide burn stats which have their own history log for that).
function sessionBurnValue(cost) {
  const durationMs = cost?.total_duration_ms ?? 0;
  if (durationMs < 60_000) return `${c.slate600}warming up${c.reset}`;
  const usd = cost?.total_cost_usd ?? 0;
  const rate = usd / (durationMs / 3_600_000);
  return `${c.slate600}$${rate.toFixed(2)}/hr${c.reset}`;
}

// Other Claude sessions running on this machine, counted from their unix
// sockets in /tmp/cc-socks — one per live session, so the count is exact and
// costs a single readdir.
//
// Deliberately count only. A "N quiet" companion was tried and removed: the
// only shell-visible activity signal is transcript mtime, and transcripts
// outlive their sessions by hours (17 recent files against 7 live sessions when
// this was written), so the quiet figure saturated and always read "7 · 7
// quiet". Stall detection needs session status — busy vs idle vs waiting —
// which lives in ListAgents and is reachable only from inside a session. That
// is what ~/.claude/bin/mayor-watch.sh and /mayor are for; this segment answers
// "how many are running", nothing more.
function peersValue() {
  let total;
  try {
    total = readdirSync("/tmp/cc-socks").filter((f) => f.endsWith(".sock")).length;
  } catch {
    return `${c.slate600}—${c.reset}`;
  }
  const peers = Math.max(0, total - 1); // this session holds one of them
  if (peers === 0) return `${c.slate600}none${c.reset}`;
  return `${c.green}●${c.reset} ${c.slate600}${peers}${c.reset}`;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsi(str, width) {
  const visible = stripAnsi(str).length;
  const padding = Math.max(0, width - visible);
  return str + " ".repeat(padding);
}

// ── Wrapping ──────────────────────────────────────────────────────────────────
// The status line runs with its stdout piped, so process.stdout.columns is
// always null and COLUMNS is not exported into it. /dev/tty works when the
// process still has a controlling terminal, so try that first, then COLUMNS,
// then the configured value, then a conservative default.
function detectWidth(config) {
  const configured = Number(config?.maxWidth);
  if (Number.isFinite(configured) && configured > 0) return configured;
  try {
    const fd = openSync("/dev/tty", "r+");
    const cols = tty.isatty(fd) ? new tty.WriteStream(fd).columns : 0;
    closeSync(fd);
    if (cols > 0) return cols;
  } catch { /* no controlling terminal — fall through */ }
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 0) return env;
  return 120;
}

// Greedily pack column indexes into rows that fit maxWidth. Always keeps at
// least one column per row, so a single over-wide column overflows rather than
// producing an empty row.
function groupByWidth(widths, maxWidth, sepWidth) {
  const groups = [];
  let cur = [];
  let curW = 0;
  for (let i = 0; i < widths.length; i++) {
    const add = (cur.length === 0 ? 0 : sepWidth) + widths[i];
    if (cur.length > 0 && curW + add > maxWidth) {
      groups.push(cur);
      cur = [i];
      curW = widths[i];
    } else {
      cur.push(i);
      curW += add;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}



function render(usage, burn5h, burn7d, transcript, contextPct, modelId, version, latestVersion, cost, stdinData, config) {
  const pipe = `${c.slate800}│`;
  const show = (id) => config.columns.includes(id);

  // ── Build columns: { label, value } ──
  const columns = [];

  // Directory
  if (show("Directory")) {
    const workDir = stdinData?.workspace?.current_dir ?? "N/A";
    columns.push({ label: `${c.slate800bold}Directory:${c.reset}`, value: `${c.slate600}${workDir}${c.reset}` });
  }

  // Branch
  if (show("Branch")) {
    const git = getGitBranch(stdinData?.workspace?.current_dir);
    let branchValue;
    if (git) {
      const branchColor = git.dirty ? c.red : c.green;
      branchValue = `${branchColor}${git.branch}${git.dirty ? "*" : ""}${c.reset}`;
    } else {
      branchValue = `${c.slate600}N/A${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}Branch:${c.reset}`, value: branchValue });
  }

  // Model
  if (show("Model")) {
    columns.push({ label: `${c.slate800bold}Model:${c.reset}`, value: `${c.slate600}${modelId}${c.reset}` });
  }

  // Context — one bar, not stacked like the Usage columns: there's no time
  // axis to pace against here, just tokens used vs. the window size. Text on
  // top, bar underneath (rather than side by side) — narrower column, since
  // the number is already stated and the bar doesn't need to repeat it.
  if (show("Context")) {
    const ctxColor = colorForPercent(contextPct);
    const ctxValue = `${drawBar(contextPct, 5, ctxColor)} ${ctxColor}${contextPct}%${c.reset}`;
    columns.push({ label: `${c.slate800bold}Context:${c.reset}`, value: ctxValue });
  }

  // Changes
  if (show("Changes")) {
    const added = cost?.total_lines_added ?? 0;
    const removed = cost?.total_lines_removed ?? 0;
    let chgValue;
    if (added || removed) {
      chgValue = `${c.green}+${added}${c.reset}${c.slate600}/${c.reset}${c.red}-${removed}${c.reset}`;
    } else {
      chgValue = `${c.slate600}+0/-0${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}Changes:${c.reset}`, value: chgValue });
  }

  // 5h rate limit
  if (show("5h Usage")) {
    const fhValue = usage ? usageBarValue(usage.fiveHour, usage.fiveHourResets, FIVE_HOUR_MS) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}5h Usage:${c.reset}`, value: fhValue });
  }

  // 7d rate limit
  if (show("7d Usage")) {
    const wkValue = usage ? usageBarValue(usage.sevenDay, usage.sevenDayResets, SEVEN_DAY_MS) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}7d Usage:${c.reset}`, value: wkValue });
  }

  // 5h burn rate — ACCOUNT-WIDE (last hour / trailing-week avg, %/hr).
  // Anthropic's usage API reports utilization against the account's rate
  // limit, not per-terminal, so this is every terminal combined.
  if (show("5h Burn")) {
    columns.push({ label: `${c.slate800bold}5h Burn (all):${c.reset}`, value: burnValue(burn5h) });
  }

  // 7d burn rate — same two stats and same account-wide scope, computed on
  // the 7d utilization series.
  if (show("7d Burn")) {
    columns.push({ label: `${c.slate800bold}7d Burn (all):${c.reset}`, value: burnValue(burn7d) });
  }

  // This terminal's own $/hr, averaged over its lifetime — the local
  // counterpart to the account-wide Burn columns above. Not the same unit
  // (dollars vs. %-of-quota; there's no published token→quota conversion to
  // bridge them), but with several terminals running it answers "which one
  // is the heavy one" that the account-wide numbers can't.
  // Peers stacks as a sub-line under This Terminal rather than taking its own
  // column — same pattern as Version/Updated. Both are "about this machine
  // right now", and a whole column for one short count wasted the width.
  if (show("This Terminal")) {
    const lines = [sessionBurnValue(cost)];
    if (show("Peers")) lines.push(`${c.slate800}Peers:${c.reset} ${peersValue()}`);
    columns.push({ label: `${c.slate800bold}This Terminal:${c.reset}`, value: lines });
  } else if (show("Peers")) {
    // Standalone fallback when This Terminal is switched off, so enabling Peers
    // alone still renders something.
    columns.push({ label: `${c.slate800bold}Peers:${c.reset}`, value: peersValue() });
  }

  // Version, with the usage-data fetch time stacked underneath — the bars'
  // countdown is always live, but their %-used reading is this snapshot.
  if (show("Version")) {
    const displayVersion = version || latestVersion;
    const updated = updatedLine(usage?.fetchedAt);
    if (displayVersion) {
      const dot = (version && latestVersion && version !== latestVersion)
        ? `${c.yellow}●${c.reset}` : `${c.green}●${c.reset}`;
      const line1 = `${dot} ${c.slate600}v${displayVersion}${c.reset}`;
      columns.push({ label: `${c.slate800bold}Version:${c.reset}`, value: updated ? [line1, updated] : [line1] });
    } else {
      const line1 = `${c.slate600}N/A${c.reset}`;
      columns.push({ label: `${c.slate800bold}Version:${c.reset}`, value: updated ? [line1, updated] : [line1] });
    }
  }

  // Session
  if (show("Session")) {
    const durationMs = cost?.total_duration_ms ?? 0;
    const sessionVal = durationMs > 0 ? formatDuration(durationMs) : "N/A";
    columns.push({ label: `${c.slate800bold}Session:${c.reset}`, value: `${c.slate600}${sessionVal}${c.reset}` });
  }

  // Cost (session cost in USD)
  if (show("Cost")) {
    const usd = cost?.total_cost_usd ?? 0;
    const costColor = usd >= 1 ? c.red : usd >= 0.25 ? c.yellow : c.green;
    columns.push({ label: `${c.slate800bold}Cost:${c.reset}`, value: `${costColor}$${usd.toFixed(2)}${c.reset}` });
  }

  // Tokens (input tokens in current context)
  if (show("Tokens")) {
    const cu = stdinData?.context_window?.current_usage;
    const total = (cu?.input_tokens ?? 0) + (cu?.cache_creation_input_tokens ?? 0) + (cu?.cache_read_input_tokens ?? 0);
    columns.push({ label: `${c.slate800bold}Tokens:${c.reset}`, value: `${c.slate600}${formatTokens(total)}${c.reset}` });
  }

  // Output Tokens (cumulative output tokens across session)
  if (show("Output Tokens")) {
    const outTokens = stdinData?.context_window?.total_output_tokens ?? 0;
    columns.push({ label: `${c.slate800bold}Out Tokens:${c.reset}`, value: `${c.slate600}${formatTokens(outTokens)}${c.reset}` });
  }

  // Cache (cache read vs total tokens)
  if (show("Cache")) {
    const cu = stdinData?.context_window?.current_usage;
    const cacheRead = cu?.cache_read_input_tokens ?? 0;
    const total = (cu?.input_tokens ?? 0) + (cu?.cache_creation_input_tokens ?? 0) + cacheRead;
    const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
    const cacheColor = cachePct >= 50 ? c.green : cachePct >= 20 ? c.yellow : c.slate600;
    columns.push({ label: `${c.slate800bold}Cache:${c.reset}`, value: `${cacheColor}${cachePct}%${c.reset} ${c.slate600}hit${c.reset}` });
  }

  // API Time (time spent waiting for API responses)
  if (show("API Time")) {
    const apiMs = cost?.total_api_duration_ms ?? 0;
    const apiVal = apiMs > 0 ? formatDuration(apiMs) : "N/A";
    columns.push({ label: `${c.slate800bold}API Time:${c.reset}`, value: `${c.slate600}${apiVal}${c.reset}` });
  }

  // 5h Reset (standalone countdown)
  if (show("5h Reset")) {
    const resetStr = usage?.fiveHourResets ? formatResetTime(usage.fiveHourResets) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}5h Reset:${c.reset}`, value: resetStr || `${c.slate600}N/A${c.reset}` });
  }

  // 7d Reset (standalone countdown)
  if (show("7d Reset")) {
    const resetStr = usage?.sevenDayResets ? formatResetTime(usage.sevenDayResets) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}7d Reset:${c.reset}`, value: resetStr || `${c.slate600}N/A${c.reset}` });
  }

  const layout = config.layout || "vertical";
  const blankLine = `\n${c.reset}\u200B`;
  let output;

  // Wrap onto extra rows instead of letting the terminal truncate with "…".
  const termWidth = detectWidth(config);
  const SEP = 3; // visible width of " │ "

  // A column's value is normally one line; usage bars return two (quota bar,
  // elapsed/pace bar) to stack them under their label instead of cramming
  // both onto one line. Every column not using it just leaves the extra
  // line(s) blank — this stays generic rather than special-casing bar columns.
  const valueLines = (col) => (Array.isArray(col.value) ? col.value : [col.value]);

  if (layout === "horizontal") {
    // ── Horizontal: "label value" cells, wrapped across rows ── multi-line
    // values are joined with a space here since a horizontal cell is one row.
    const cells = columns.map((col) => `${col.label} ${valueLines(col).join(" ")}`);
    const widths = cells.map((cell) => stripAnsi(cell).length);
    output = groupByWidth(widths, termWidth, SEP)
      .map((g) => c.reset + g.map((i) => cells[i]).join(` ${pipe} `) + c.reset)
      .join("\n");
  } else {
    // ── Vertical (default): label row, then one row per value line (padded
    // to the tallest column in the group), wrapped across row groups ──
    const colWidths = columns.map((col) => {
      const labelLen = stripAnsi(col.label).length;
      const valueLen = Math.max(0, ...valueLines(col).map((v) => stripAnsi(v).length));
      return Math.max(labelLen, valueLen);
    });
    const rows = [];
    for (const g of groupByWidth(colWidths, termWidth, SEP)) {
      // Don't pad the final column of a row: trailing spaces would count
      // toward the width and could push the row over on their own.
      const cell = (raw, i, isLast) => (isLast ? raw : padAnsi(raw, colWidths[i]));
      rows.push(c.reset + g.map((i, n) => cell(columns[i].label, i, n === g.length - 1)).join(` ${pipe} `) + c.reset);
      const maxLines = Math.max(...g.map((i) => valueLines(columns[i]).length));
      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        rows.push(c.reset + g.map((i, n) => cell(valueLines(columns[i])[lineIdx] ?? "", i, n === g.length - 1)).join(` ${pipe} `) + c.reset);
      }
    }
    output = rows.join("\n");
  }

  // ── Line 3: Agents, Agent name, Todos (only if any exist) ──
  const line3 = [];
  const running = transcript.agents.filter((a) => a.status === "running");

  if (running.length > 0) {
    line3.push(`${c.slate800bold}Agents:${c.reset} ${c.cyan}${running.length}${c.reset}`);
  }

  const agentName = stdinData?.agent?.name;
  if (agentName) {
    line3.push(`${c.slate800bold}Agent:${c.reset} ${c.magenta}${agentName}${c.reset}`);
  }

  if (transcript.todos.length > 0) {
    const done = transcript.todos.filter((t) => t.status === "completed").length;
    const total = transcript.todos.length;
    const todoColor = done === total ? c.green : c.yellow;
    line3.push(`${c.slate800bold}Todos:${c.reset} ${todoColor}${done}/${total}${c.reset}`);
  }

  if (line3.length > 0) {
    const line3Sep = ` ${pipe} `;
    output += blankLine + "\n" + c.reset + line3.join(line3Sep);
  }

  // Agent detail tree
  const agentLines = [];
  if (running.length > 0) {
    for (let i = 0; i < running.length && i < 5; i++) {
      const a = running[i];
      const isLast = i === running.length - 1 || i === 4;
      const prefix = isLast ? "└─" : "├─";
      const elapsed = formatDuration(Date.now() - a.startTime.getTime());
      const type = (a.type || "agent").substring(0, 14);
      const desc = (a.description || "").substring(0, 45);
      const modelLabel = a.model === "opus" ? `${c.magenta}Opus${c.reset}` : a.model === "haiku" ? `${c.green}Haiku${c.reset}` : `${c.cyan}Sonnet${c.reset}`;
      agentLines.push(`${c.reset}${c.slate800}${prefix}${c.reset} ${c.white}${type}${c.reset} ${modelLabel} ${c.slate600}${elapsed.padStart(5)}${c.reset}   ${c.slate600}${desc}${c.reset}`);
    }
  }

  if (agentLines.length > 0) {
    output += "\n" + agentLines.join("\n");
  }

  return (output + blankLine + "\n").replace(/ /g, "\u00A0");
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const stdin = await readStdin();
  if (!stdin) {
    console.log(`${c.dim}[HUD] waiting for data...${c.reset}`);
    return;
  }

  const config = readConfig();
  const contextPct = getContextPercent(stdin);
  const modelId = getModelId(stdin);
  const version = getVersion(stdin);

  // Run usage API, transcript parsing, and version check concurrently
  const [usage, transcript, latestVersion] = await Promise.all([
    getUsage(),
    parseTranscript(stdin.transcript_path),
    getLatestVersion(),
  ]);

  const now = Date.now();
  const history = readHistory();
  const burn5h = computeBurnStats(history, "fiveHour", "fiveHourResets", FIVE_HOUR_MS, usage?.fiveHourResets ?? null, usage?.fiveHour, now);
  const burn7d = computeBurnStats(history, "sevenDay", "sevenDayResets", SEVEN_DAY_MS, usage?.sevenDayResets ?? null, usage?.sevenDay, now);

  console.log(render(usage, burn5h, burn7d, transcript, contextPct, modelId, version, latestVersion, stdin.cost, stdin, config));
}

main().catch((err) => {
  console.log(`[HUD] error: ${err.message}`);
});
