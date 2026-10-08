// ─────────────────────────────────────────────────────────────────────────────
// Fleet status for the QA tool: one page that says whether the instances are up,
// and whether they have BEEN up.
//
// This exists because of a real outage. SE4 spent a day dying a minute after every
// start and being revived by its 5-minute trigger. Every spot check found it either
// up or down depending on when it landed, and nothing recorded the pattern, so it
// looked healthy right up until someone happened to load it at the wrong moment.
// A status you can only sample is not a status you can trust.
//
// ── DELIBERATELY READ-ONLY ──────────────────────────────────────────────────
//
// No restart buttons, no control endpoints, nothing that changes state. The app
// this watches has NO AUTHENTICATION and sits on a network where the firewall
// profile is disabled, so anything actionable here would be actionable by anyone
// who can route to the box. Control stays on SSH, which is scoped to one address.
//
// ── No dependencies, on purpose ─────────────────────────────────────────────
//
// Plain Node, built-ins only. Nothing to npm-install, nothing to build, no way for
// this to break the thing it is supposed to be watching, and it starts in the same
// second the box does.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.MONITOR_PORT ?? 3100);
// Loopback unless told otherwise: fail closed, like the instances and the compose
// stack. Start-Monitor.ps1 passes the BIND_ADDR from deploy.env.
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';
const FIRST_PORT = Number(process.env.MONITOR_FIRST_PORT ?? 3101);
const LAST_PORT = Number(process.env.MONITOR_LAST_PORT ?? 3111);
const LOG_DIR = process.env.MONITOR_LOG_DIR ?? 'C:\\ProgramData\\qa-shopify-tool\\logs';
const DATA_DIR = process.env.MONITOR_DATA_DIR ?? 'C:\\ProgramData\\qa-shopify-tool\\monitor';
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

const POLL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
// Activity (run counts, what is running) hits the database, unlike the health probe,
// so it is asked for less often. A minute is fresh enough for "is an import running".
const ACTIVITY_MS = 60_000;
// 7 days of 30s samples is ~20k lines and about 2 MB. Enough to answer "was it up
// overnight" and "has this been happening all week" without needing a database.
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

const ports = [];
for (let p = FIRST_PORT; p <= LAST_PORT; p++) ports.push(p);

/** Live view, rebuilt every poll. `since` is when WE first observed the current
 *  state — not the process start time, which we cannot see from here. Saying
 *  "up since, observed" is honest; claiming process uptime would not be. */
const state = new Map(
  ports.map((p) => [p, { port: p, owner: null, up: null, since: null, lastError: null }]),
);

let lastPollAt = null;

/** Latest /api/instance/activity answer per port, kept while an instance is down so
 *  the page still shows its last known counts. Null until the first answer — and
 *  for an instance deployed before that endpoint existed, which answers 404. */
const activity = new Map(ports.map((p) => [p, null]));

// ── Probing ─────────────────────────────────────────────────────────────────

function get(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    // Both matter: `timeout` fires for a socket that connects and then goes quiet
    // (a wedged event loop), `error` for refused connections (nothing listening).
    // A wedged instance is "down" for anyone trying to use it, so treat it that way.
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function probe(port) {
  const health = await get(port, '/api/health');
  const up = Boolean(health && health.status === 200);

  let owner = state.get(port).owner;
  // Only ask who it is when it is up, and keep the last known name while it is
  // down so the page can still say WHOSE instance is broken.
  if (up) {
    const inst = await get(port, '/api/instance');
    if (inst && inst.status === 200) {
      try {
        owner = JSON.parse(inst.body).owner ?? owner;
      } catch {
        /* leave the previous name in place */
      }
    }
  }
  return { up, owner };
}

/** Last line in this instance's log that looks like trouble. The launcher used to
 *  swallow node's stderr entirely; now that it is captured, this is where a crash
 *  actually explains itself. */
function lastErrorLine(port) {
  const file = path.join(LOG_DIR, `se${port - 3100}.log`);
  try {
    const stat = fs.statSync(file);
    // Read only the tail: these files roll at 20 MB and we want the last few lines.
    const bytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, Math.max(0, stat.size - bytes));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/error|exception|exited with|refus|EADDR|ECONN|failed/i.test(lines[i])) {
        return lines[i].slice(0, 300);
      }
    }
  } catch {
    /* no log yet, or unreadable — not worth failing the page over */
  }
  return null;
}

async function poll() {
  const now = Date.now();
  const results = await Promise.all(ports.map((p) => probe(p)));

  ports.forEach((port, i) => {
    const prev = state.get(port);
    const { up, owner } = results[i];
    // Only move `since` when the state actually flips, so it reads as "up since",
    // not "checked at".
    const since = prev.up === up && prev.since ? prev.since : now;
    state.set(port, { port, owner, up, since, lastError: up ? prev.lastError : lastErrorLine(port) });
  });

  lastPollAt = now;
  appendHistory(now);
}

async function pollActivity() {
  await Promise.all(
    ports.map(async (port) => {
      if (!state.get(port).up) return;
      const res = await get(port, '/api/instance/activity');
      if (!res || res.status !== 200) return;
      try {
        activity.set(port, { ...JSON.parse(res.body), fetchedAt: Date.now() });
      } catch {
        /* keep the previous answer */
      }
    }),
  );
}

// ── History ─────────────────────────────────────────────────────────────────
//
// One line per poll: the timestamp and a bitmask of which ports answered, plus the
// port that bit 0 stands for (`b`) and how many ports the mask covers (`n`).
// Compact enough to keep a week of 30-second samples in a flat file, and trivially
// greppable if this page is ever the thing that is broken.
//
// The mask is anchored to a PORT NUMBER, not to "whatever FIRST_PORT is today".
// Records written before `b` existed carry only {t, m} with bit 0 = 3101 (FIRST_PORT
// has always been SE1's port); they are read with LEGACY_BASE_PORT. Without the
// anchor, a change to the first watched port slid a week of history onto the wrong
// SEs.
//
// The history is held in memory: loaded once at start, appended per poll, pruned in
// place. The file is the durable copy, not something every page view re-reads and
// re-parses (~20k lines at full retention, filtered once per instance per view).

const LEGACY_BASE_PORT = 3101;
const MAX_MASK_BITS = 30; // stay clear of the sign bit in JS bitwise ops

/** Normalise a parsed line to {t, b, n, m}, or null if it is not a sample. */
function normaliseRecord(rec) {
  if (!rec || typeof rec.t !== 'number' || typeof rec.m !== 'number') return null;
  if (typeof rec.b === 'number') {
    return { t: rec.t, b: rec.b, n: typeof rec.n === 'number' ? rec.n : MAX_MASK_BITS, m: rec.m };
  }
  return { t: rec.t, b: LEGACY_BASE_PORT, n: MAX_MASK_BITS, m: rec.m };
}

/** true / false for a port in this sample, or null when the sample did not watch it. */
function upAt(rec, port) {
  const bit = port - rec.b;
  if (bit < 0 || bit >= rec.n || bit >= MAX_MASK_BITS) return null;
  return Boolean(rec.m & (1 << bit));
}

function loadHistoryFile() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const cutoff = Date.now() - RETAIN_MS;
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = normaliseRecord(JSON.parse(line));
        if (rec && rec.t >= cutoff) out.push(rec);
      } catch {
        /* skip a torn line rather than lose the file */
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  } catch {
    return [];
  }
}

/** In-memory history, oldest first. */
let history = loadHistoryFile();

function appendHistory(now) {
  const base = ports[0];
  const n = Math.min(ports.length, MAX_MASK_BITS);
  let mask = 0;
  ports.forEach((p, i) => {
    if (i < n && state.get(p).up) mask |= 1 << i;
  });
  const rec = { t: now, b: base, n, m: mask };
  history.push(rec);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + '\n');
  } catch {
    /* a failed write must not stop the polling */
  }
}

/** Drop anything older than the retention window, in memory and on disk. Rewriting
 *  the file keeps it from growing without bound the way product_original_rows does.
 *  Old-format lines are rewritten in the new format, with their base made explicit. */
function pruneHistory() {
  const cutoff = Date.now() - RETAIN_MS;
  let drop = 0;
  while (drop < history.length && history[drop].t < cutoff) drop++;
  if (drop > 0) history = history.slice(drop);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, history.map((r) => JSON.stringify(r)).join('\n') + (history.length ? '\n' : ''));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {
    /* not worth failing over */
  }
}

/** Samples newer than `windowMs` ago. History is time-ordered, so walk back from the end. */
function samplesWithin(windowMs) {
  const cutoff = Date.now() - windowMs;
  let i = history.length;
  while (i > 0 && history[i - 1].t >= cutoff) i--;
  return history.slice(i);
}

/** Availability and restart count per port over a set of samples. A "restart" here
 *  is an observed down→up transition — which is exactly the signal that was missing
 *  when SE4 was being quietly revived every five minutes. */
function summarise(rows) {
  return ports.map((port) => {
    let seen = 0;
    let upCount = 0;
    let recoveries = 0;
    let prevUp = null;
    for (const r of rows) {
      const up = upAt(r, port);
      if (up === null) continue; // this sample did not watch this port
      seen++;
      if (up) upCount++;
      if (prevUp === false && up) recoveries++;
      prevUp = up;
    }
    return {
      port,
      samples: seen,
      availability: seen ? upCount / seen : null,
      recoveries,
    };
  });
}

/** A compact strip of the last 24h for the sparkline on the page. */
function strip(dayRows, port, buckets = 96) {
  if (dayRows.length === 0) return [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const span = 24 * 60 * 60 * 1000 / buckets;
  const out = new Array(buckets).fill(null);
  for (const r of dayRows) {
    const up = upAt(r, port);
    if (up === null) continue;
    const idx = Math.max(0, Math.min(buckets - 1, Math.floor((r.t - cutoff) / span)));
    // A bucket is only "up" if every sample in it was up: a bucket that hides one
    // failure is the same lie a spot check tells.
    out[idx] = out[idx] === null ? up : out[idx] && up;
  }
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function statusPayload() {
  const dayRows = samplesWithin(24 * 60 * 60 * 1000);
  const day = summarise(dayRows);
  const week = summarise(samplesWithin(RETAIN_MS));
  return {
    now: Date.now(),
    lastPollAt,
    pollSeconds: POLL_MS / 1000,
    instances: ports.map((port, i) => ({
      ...state.get(port),
      se: `SE${port - 3100}`,
      activity: activity.get(port),
      day: day[i],
      week: week[i],
      strip: strip(dayRows, port),
    })),
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function pct(v) {
  if (v === null || v === undefined) return '—';
  const p = v * 100;
  return (p >= 99.95 ? '100' : p.toFixed(p < 95 ? 1 : 2)) + '%';
}

function num(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** One SE's runs as "total" with the per-kind split underneath. Validations and
 *  uploads are the checks; imports are what actually reached a test store. */
function runCell(runs, key) {
  if (!runs) return '<span class="muted">—</span>';
  const pick = (k) => runs[k][key];
  const total = pick('customerValidations') + pick('customerImports') + pick('productUploads') + pick('productImports');
  return `<span class="big">${num(total)}</span>
    <span class="split">cust ${num(pick('customerValidations'))} checked · ${num(pick('customerImports'))} imported<br>
    prod ${num(pick('productUploads'))} checked · ${num(pick('productImports'))} imported</span>`;
}

function nowCell(i) {
  const a = i.activity;
  if (!a) {
    return i.up
      ? '<span class="muted" title="This instance predates /api/instance/activity — redeploy it">not reported</span>'
      : '<span class="muted">—</span>';
  }
  if (a.active.length === 0) return '<span class="muted">idle</span>';
  return a.active
    .map((op) => {
      const size = op.size ? ` · ${num(op.size)}` : '';
      const where = op.shop ? op.shop.replace(/\.myshopify\.com$/, '') : op.storeId;
      const stale = op.stale
        ? ' <span class="flag" title="No browser is polling this run, so its status will not update until someone opens it. Shopify may still be working on it.">not watched</span>'
        : '';
      return `<div class="op"><span class="live"></span>${escapeHtml(op.operation)} → ${escapeHtml(where)}${size}
        <span class="muted">· ${ago(Date.parse(op.startedAt))}</span>${stale}</div>`;
    })
    .join('');
}

function renderActivity(instances) {
  const rows = instances
    .map((i) => {
      const a = i.activity;
      const last = a && a.lastRequestAt ? `${ago(Date.parse(a.lastRequestAt))} ago` : '—';
      return `<tr>
        <td class="se">${escapeHtml(i.se)}</td>
        <td class="owner">${escapeHtml((a && a.owner) ?? i.owner ?? '—')}</td>
        <td>${nowCell(i)}</td>
        <td class="num">${last}</td>
        <td class="num">${runCell(a && a.runs, 'last7d')}</td>
        <td class="num">${runCell(a && a.runs, 'total')}</td>
      </tr>`;
    })
    .join('\n');
  const running = instances.reduce((n, i) => n + (i.activity ? i.activity.active.length : 0), 0);
  return `<h2>Activity <span class="muted">· ${running === 0 ? 'nothing running' : `${running} running now`}</span></h2>
<div class="card"><table>
<thead><tr><th>SE</th><th>Owner</th><th>Now</th><th>Last active</th><th>Runs 7d</th><th>Runs total</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

function renderPage(linkHost) {
  const data = statusPayload();
  const downCount = data.instances.filter((i) => i.up === false).length;
  const unknown = data.instances.filter((i) => i.up === null).length;

  const rows = data.instances
    .map((i) => {
      const cls = i.up === null ? 'unknown' : i.up ? 'up' : 'down';
      const label = i.up === null ? 'no data yet' : i.up ? 'up' : 'DOWN';
      const bars = i.strip
        .map((b) => `<i class="${b === null ? 'n' : b ? 'u' : 'd'}"></i>`)
        .join('');
      const flap =
        i.day.recoveries >= 3
          ? `<span class="flag" title="Observed down-to-up transitions in 24h">restarted ${i.day.recoveries}×</span>`
          : i.day.recoveries > 0
            ? `<span class="muted">restarted ${i.day.recoveries}×</span>`
            : '<span class="muted">—</span>';
      return `<tr class="${cls}">
        <td class="se">${escapeHtml(i.se)}</td>
        <td class="owner">${escapeHtml(i.owner ?? '—')}</td>
        <td><a href="http://${escapeHtml(linkHost)}:${i.port}/" target="_blank" rel="noopener">:${i.port}</a></td>
        <td><span class="dot"></span>${label}</td>
        <td class="num">${i.up === null ? '—' : ago(i.since)}</td>
        <td class="num">${pct(i.day.availability)}</td>
        <td class="num">${pct(i.week.availability)}</td>
        <td>${flap}</td>
        <td class="strip">${bars}</td>
      </tr>
      ${i.lastError ? `<tr class="errrow"><td></td><td colspan="8"><code>${escapeHtml(i.lastError)}</code></td></tr>` : ''}`;
    })
    .join('\n');

  const banner =
    downCount > 0
      ? `<div class="banner bad">${downCount} instance${downCount > 1 ? 's' : ''} DOWN</div>`
      : unknown > 0
        ? '<div class="banner warn">collecting first samples…</div>'
        : '<div class="banner ok">all instances up</div>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QA tool — fleet status</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  :root{--bg:#f6f7f9;--fg:#1c2024;--mut:#6b7280;--line:#e3e6ea;--card:#fff;
        --up:#12855c;--down:#c0392b;--warn:#b26b00;--unk:#9aa1a9}
  @media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8ea;--mut:#98a0a8;
        --line:#272c31;--card:#1b1f23;--up:#3ecf8e;--down:#ff6b5e;--warn:#e3a008;--unk:#5b636b}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:18px;margin:0 0 2px}
  .sub{color:var(--mut);font-size:12.5px;margin-bottom:18px}
  .banner{padding:10px 14px;border-radius:8px;font-weight:600;margin-bottom:18px}
  .banner.ok{background:color-mix(in srgb,var(--up) 14%,transparent);color:var(--up)}
  .banner.bad{background:color-mix(in srgb,var(--down) 14%,transparent);color:var(--down)}
  .banner.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:820px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;
     color:var(--mut);font-weight:600;padding:11px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  .se{font-weight:700}
  .owner{font-weight:500}
  .num{font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:var(--mut)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--unk)}
  tr.up .dot{background:var(--up)} tr.down .dot{background:var(--down)}
  tr.down td{background:color-mix(in srgb,var(--down) 7%,transparent)}
  tr.down{color:var(--down);font-weight:600}
  .flag{color:var(--warn);font-weight:600}
  .strip{white-space:nowrap;line-height:0}
  .strip i{display:inline-block;width:3px;height:16px;margin-right:1px;border-radius:1px;background:var(--unk)}
  .strip i.u{background:var(--up)} .strip i.d{background:var(--down)} .strip i.n{background:var(--line)}
  .errrow td{padding-top:0;border-bottom:1px solid var(--line)}
  .errrow code{display:block;font-size:11.5px;color:var(--mut);white-space:pre-wrap;word-break:break-word}
  h2{font-size:15px;margin:28px 0 10px} h2 .muted{font-weight:400;font-size:13px}
  .big{font-weight:600;display:block}
  .split{display:block;font-size:11.5px;color:var(--mut);line-height:1.45}
  .op{white-space:nowrap} .op+.op{margin-top:4px}
  .live{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--up);
        animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.live{animation:none}}
  a{color:inherit} .foot{color:var(--mut);font-size:12px;margin-top:16px;line-height:1.7}
</style></head><body><div class="wrap">
<h1>QA tool — fleet status</h1>
<div class="sub">HELIOS-SERVER · polling every ${data.pollSeconds}s · last poll ${ago(data.lastPollAt)} ago · page refreshes every 30s</div>
${banner}
<div class="card"><table>
<thead><tr><th>SE</th><th>Owner</th><th>Port</th><th>State</th><th>For</th><th>24h</th><th>7d</th><th>Restarts 24h</th><th>Last 24h</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${renderActivity(data.instances)}
<div class="foot">
<strong>For</strong> is how long it has held its current state as observed from here, not process uptime.
<strong>Restarts</strong> counts down→up transitions this page actually saw — a healthy instance shows none, and a
crash-loop that keeps being revived shows many. Read-only by design: no restart controls, because the network
in front of this has no authentication.<br>
<strong>Runs</strong> are counted by the name typed into the tool, so they are only as right as that name.
<strong>Now</strong> is attributed by store — each instance holds only its own SE's stores — and
<strong>not watched</strong> means no open browser is polling that run, so its status will not advance until someone opens it.
<strong>Last active</strong> is the instance's last request from a browser; it resets when the instance restarts.
</div>
</div></body></html>`;
}

// ── Link host ───────────────────────────────────────────────────────────────
//
// Used only to build clickable links to the instances. Whatever host THIS reader
// reached the page on is the host they can reach the instances on -- so it is
// worked out per request. It used to be one module-level variable overwritten by
// every request, so a viewer on localhost rewrote everyone else's links to
// http://localhost:3101.

/** Fallback when a request carries no usable Host: the bind address if it is a
 *  specific one, else this machine's name. */
const FALLBACK_LINK_HOST = (() => {
  if (BIND_ADDR && BIND_ADDR !== '0.0.0.0' && BIND_ADDR !== '::') {
    return BIND_ADDR.includes(':') ? `[${BIND_ADDR}]` : BIND_ADDR;
  }
  return os.hostname();
})();

/** The Host header's hostname part, validated, ready to put in a URL ("[::1]" for
 *  IPv6). Anything that is not a plain hostname / IPv4 / bracketed IPv6 is ignored. */
function linkHostFor(req) {
  const raw = String(req.headers.host ?? '').trim();
  // [IPv6]:port or [IPv6]
  const v6 = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(raw);
  if (v6) return `[${v6[1]}]`;
  // hostname or IPv4, optional :port
  const v4 = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?$/.exec(raw);
  if (v4) return v4[1];
  return FALLBACK_LINK_HOST;
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(statusPayload()));
    return;
  }
  if (url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPage(linkHostFor(req)));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

pruneHistory();
poll().then(pollActivity);
setInterval(poll, POLL_MS);
setInterval(pollActivity, ACTIVITY_MS);
setInterval(pruneHistory, 6 * 60 * 60 * 1000);

server.listen(PORT, BIND_ADDR, () => {
  console.log(`fleet monitor listening on http://localhost:${PORT} (bound to ${BIND_ADDR}), watching ${FIRST_PORT}-${LAST_PORT}`);
});
