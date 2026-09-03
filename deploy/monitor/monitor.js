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
const path = require('path');

const PORT = Number(process.env.MONITOR_PORT ?? 3100);
const BIND_ADDR = process.env.BIND_ADDR ?? '0.0.0.0';
const FIRST_PORT = Number(process.env.MONITOR_FIRST_PORT ?? 3101);
const LAST_PORT = Number(process.env.MONITOR_LAST_PORT ?? 3108);
const LOG_DIR = process.env.MONITOR_LOG_DIR ?? 'C:\\ProgramData\\qa-shopify-tool\\logs';
const DATA_DIR = process.env.MONITOR_DATA_DIR ?? 'C:\\ProgramData\\qa-shopify-tool\\monitor';
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

const POLL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
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

// ── History ─────────────────────────────────────────────────────────────────
//
// One line per poll: the timestamp and a bitmask of which ports answered. Compact
// enough to keep a week of 30-second samples in a flat file, and trivially
// greppable if this page is ever the thing that is broken.

function appendHistory(now) {
  let mask = 0;
  ports.forEach((p, i) => {
    if (state.get(p).up) mask |= 1 << i;
  });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ t: now, m: mask }) + '\n');
  } catch {
    /* a failed write must not stop the polling */
  }
}

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const cutoff = Date.now() - RETAIN_MS;
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.t >= cutoff) out.push(rec);
      } catch {
        /* skip a torn line rather than lose the file */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Rewrite the file without anything older than the retention window. Cheap at this
 *  size, and it keeps the file from growing without bound the way
 *  product_original_rows does. */
function pruneHistory() {
  const kept = readHistory();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  } catch {
    /* not worth failing over */
  }
}

/** Availability and restart count per port over a window. A "restart" here is an
 *  observed down→up transition — which is exactly the signal that was missing when
 *  SE4 was being quietly revived every five minutes. */
function summarise(history, windowMs) {
  const cutoff = Date.now() - windowMs;
  const rows = history.filter((r) => r.t >= cutoff);
  return ports.map((port, i) => {
    let seen = 0;
    let upCount = 0;
    let recoveries = 0;
    let prevUp = null;
    for (const r of rows) {
      const up = Boolean(r.m & (1 << i));
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

/** A compact strip of the last N samples for the sparkline on the page. */
function strip(history, portIndex, buckets = 96) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = history.filter((r) => r.t >= cutoff);
  if (rows.length === 0) return [];
  const span = 24 * 60 * 60 * 1000 / buckets;
  const out = new Array(buckets).fill(null);
  for (const r of rows) {
    const idx = Math.min(buckets - 1, Math.floor((r.t - cutoff) / span));
    const up = Boolean(r.m & (1 << portIndex));
    // A bucket is only "up" if every sample in it was up: a bucket that hides one
    // failure is the same lie a spot check tells.
    out[idx] = out[idx] === null ? up : out[idx] && up;
  }
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function statusPayload() {
  const history = readHistory();
  const day = summarise(history, 24 * 60 * 60 * 1000);
  const week = summarise(history, 7 * 24 * 60 * 60 * 1000);
  return {
    now: Date.now(),
    lastPollAt,
    pollSeconds: POLL_MS / 1000,
    instances: ports.map((port, i) => ({
      ...state.get(port),
      se: `SE${port - 3100}`,
      day: day[i],
      week: week[i],
      strip: strip(history, i),
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

function renderPage() {
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
        <td><a href="http://${escapeHtml(HOSTNAME_FOR_LINKS)}:${i.port}/" target="_blank" rel="noopener">:${i.port}</a></td>
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
<div class="foot">
<strong>For</strong> is how long it has held its current state as observed from here, not process uptime.
<strong>Restarts</strong> counts down→up transitions this page actually saw — a healthy instance shows none, and a
crash-loop that keeps being revived shows many. Read-only by design: no restart controls, because the network
in front of this has no authentication.
</div>
</div></body></html>`;
}

// Used only to build clickable links to the instances. Whatever host the page was
// reached on is the host the reader can reach the instances on.
let HOSTNAME_FOR_LINKS = '10.20.30.208';

const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  if (host) HOSTNAME_FOR_LINKS = host;

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
    res.end(renderPage());
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

pruneHistory();
poll();
setInterval(poll, POLL_MS);
setInterval(pruneHistory, 6 * 60 * 60 * 1000);

server.listen(PORT, BIND_ADDR, () => {
  console.log(`fleet monitor listening on http://localhost:${PORT} (bound to ${BIND_ADDR}), watching ${FIRST_PORT}-${LAST_PORT}`);
});
