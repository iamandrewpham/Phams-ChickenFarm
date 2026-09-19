/**
 * Pham's Chickens - offline watcher
 *
 * Runs every 10 minutes from GitHub Actions (see .github/workflows/offline-watch.yml). Signs in to Sensaphone.net, asks whether
 * it can still reach the monitor unit and whether every house's inputs are answering, and keeps a shared log of the stretches
 * they were not:
 *
 *   <LOG_DIR>/offline-log.json   the log itself - entries in the same shape the monitor page uses, so the page merges them in
 *   <LOG_DIR>/status.json        a heartbeat: when this last ran and what it saw, so the page can tell if the watcher stopped
 *
 * Both live on the repo's `data` branch, not `main`, so a heartbeat never redeploys the site. The page reads them from
 * raw.githubusercontent.com, which is why the repo needs to stay public (or the two URLs in index.html need a token).
 *
 * Usage:  SENSAPHONE_USER=… SENSAPHONE_PASS=… node scripts/offline-watch.mjs [LOG_DIR]
 * Test:   SENSAPHONE_FAKE=online|offline node scripts/offline-watch.mjs ./tmp    (no network; pretends the unit is in that state)
 */

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://rest.sensaphone.net/api/v1';
const LOG_DIR = process.argv[2] || process.env.LOG_DIR || 'data-branch';
const INTERVAL_MIN = 10;                 // how often the workflow is scheduled; used to word the entries and judge missed runs
const MISSED_AFTER_MS = 40 * 60000;      // no run for this long = the watcher was down; open stretches end "at an unknown time"
const LOG_FILE = path.join(LOG_DIR, 'offline-log.json');
const STATUS_FILE = path.join(LOG_DIR, 'status.json');

// ---------------------------------------------------------------- Sensaphone plumbing (same as farm-report.mjs)

function seg(v) { return encodeURIComponent('{' + String(v) + '}'); }
async function api(method, p, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'text/plain' }; opts.body = JSON.stringify(body); }
  const res = await fetch(API + p, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`Sensaphone returned non-JSON (HTTP ${res.status})`); }
}
async function login() {
  const j = await api('POST', '/login', { request_type: 'create', resource: 'login', user_name: process.env.SENSAPHONE_USER, password: process.env.SENSAPHONE_PASS });
  const r = j.result || {};
  if (!r.success) throw new Error(`Sensaphone login failed: ${r.message || 'code ' + r.code}`);
  return { acctid: j.response.acctid, session: j.response.session };
}
const basePath = (a) => '/' + seg(a.acctid) + '/' + seg(a.session);
function unwrap(v) { return (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'value')) ? (v.is_null === true ? null : v.value) : v; }
function stateText(v) {
  v = unwrap(v);
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(stateText).filter(Boolean).join(', ');
  for (const k of ['state', 'zone_state', 'status', 'name', 'condition', 'description', 'value']) if (v[k] != null && typeof v[k] !== 'object') return String(v[k]);
  return Object.keys(v).map((k) => stateText(v[k])).filter(Boolean).join(', ');
}
const asArray = (v) => { v = unwrap(v); return v == null ? [] : (Array.isArray(v) ? v : [v]); };
const num = (v) => { v = unwrap(v); if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.+\-eE]/g, '')); return isNaN(n) ? null : n; };
function collect(x, test, depth = 0, out = []) {
  if (!x || typeof x !== 'object' || depth > 6) return out;
  if (Array.isArray(x)) { x.forEach((i) => collect(i, test, depth + 1, out)); return out; }
  if (test(x)) { out.push(x); return out; }
  for (const k of Object.keys(x)) collect(x[k], test, depth + 1, out);
  return out;
}
const findDevices = (x) => collect(x, (o) => o.device_id != null && (o.name != null || o.zone != null || o.type != null));
const findZones = (x) => collect(x, (o) => o.zone_id != null);
const ZONE_STATE = { 0: '', 1: 'Alarm', 2: 'OK', 3: 'Pending', 4: 'Open', 5: 'Closed', 6: 'Cycle', 7: 'Low', 8: 'High', 9: 'Off', 10: 'On', 11: 'Return to normal', 12: 'Route down', 13: 'Trouble', 14: 'Not responding', 15: 'Dependency failure', 16: 'Battery', 17: 'Acknowledged', 18: 'Unacknowledged' };
const isCode = (c) => typeof c === 'number' || (typeof c === 'string' && /^\d+$/.test(c));
const stateWords = (v) => asArray(v).map((c) => isCode(c) ? (ZONE_STATE[num(c)] || '') : stateText(c)).filter(Boolean).join(', ');

// ---------------------------------------------------------------- what to watch

/** -> [{key, zid, label, house, cat, off, text}] one subject per unit and per house */
async function observe() {
  if (process.env.SENSAPHONE_FAKE) {   // for a dry run without credentials
    const off = process.env.SENSAPHONE_FAKE === 'offline';
    return { subjects: [{ key: 'unit:0', zid: 'unit:0', label: 'Fake monitor unit · connection', house: null, cat: 'conn', off, text: unitText('Fake unit') }], units: [{ device_id: 0, name: 'Fake unit', online: !off }] };
  }
  const a = await login();
  const dj = await api('GET', basePath(a) + '/device');
  if (!dj.result || !dj.result.success) throw new Error('Could not read the device list: ' + (dj.result && dj.result.message));
  const devices = findDevices(dj.response);
  if (!devices.length) throw new Error('Sensaphone.net returned no devices');
  // the dashboard is the freshest word on online/offline; the device list is the fallback
  let dash = null;
  try { const d = await api('GET', basePath(a) + '/dashboard'); dash = d && d.result && d.result.success ? findDevices(d.response) : null; } catch { /* best effort */ }
  const subjects = [], units = [];
  for (const dev of devices) {
    const id = unwrap(dev.device_id), name = stateText(dev.name) || ('Device ' + id);
    const dd = dash && dash.find((x) => String(unwrap(x.device_id)) === String(id));
    const src = dd || dev;
    const isOnline = unwrap(src.is_online), conn = stateText(src.connection_status);
    const off = isOnline === false || /offline/i.test(conn);
    units.push({ device_id: id, name, online: !off, connection_status: conn });
    subjects.push({ key: 'unit:' + id, zid: 'unit:' + id, label: name + ' monitor unit · connection', house: null, cat: 'conn', off, text: unitText(name) });
    // houses: any zone of a house reporting "not responding" / "route down" means its WEB600 (or the link to it) is down
    let zones = [];
    try { const zj = await api('GET', basePath(a) + '/device/' + seg(id) + '/zone'); zones = findZones(zj.response); } catch { /* no house detail this run */ }
    const houses = {};
    for (const z of zones) {
      const nm = stateText(z.name) || stateText(z.canonical_name) || '';
      const hm = nm.match(/house\s*#?\s*(\d+)/i);
      if (!hm) continue;
      const n = parseInt(hm[1], 10), az = (z.alarm_zone && typeof z.alarm_zone === 'object') ? z.alarm_zone : {};
      const status = stateWords(z.status) || stateText(unwrap(az.alarm_status_str)) || stateWords(unwrap(az.alarm_status));
      const cond = stateWords(unwrap(az.alarm_condition));
      const dead = /not responding|route down|dependency/i.test(status + ' ' + cond);
      if (!houses[n]) houses[n] = { n, zid: unwrap(z.zone_id), cat: /^temp/i.test(nm) ? 'temp' : 'other', dead: false, any: 0 };
      if (/^temp/i.test(nm)) { houses[n].zid = unwrap(z.zone_id); houses[n].cat = 'temp'; }
      houses[n].any++;
      if (dead) houses[n].dead = true;
    }
    for (const n of Object.keys(houses).map(Number).sort((x, y) => x - y)) {
      const h = houses[n];
      // a house only counts as "off" when the unit itself is online — otherwise every house looks dead for the same reason
      subjects.push({ key: 'house:' + n, zid: String(h.zid), label: 'House ' + n + ' · inputs', house: n, cat: h.cat, off: !off && h.dead,
        text: 'House ' + n + ' inputs not responding — the WEB600 or its network link is down. Logged by the farm watcher (checks every ' + INTERVAL_MIN + ' min).' });
    }
  }
  return { subjects, units };
}
function unitText(name) { return 'Monitor unit offline — Sensaphone.net lost contact with ' + name + '. Logged by the farm watcher (checks every ' + INTERVAL_MIN + ' min).'; }

// ---------------------------------------------------------------- the log

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function stamp(ms) { return new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

function main(observed, now = Date.now()) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = readJson(LOG_FILE, { version: 1, entries: [] });
  if (!Array.isArray(log.entries)) log.entries = [];
  const status = readJson(STATUS_FILE, {});
  const lastRun = num(status.checked_at) || 0;
  const changes = [];

  // the watcher itself was down: whatever was open then ended at an unknown time - close it at the last run rather than guess
  if (lastRun && now - lastRun > MISSED_AFTER_MS) {
    for (const e of log.entries) {
      if (!e.open) continue;
      e.open = false; e.to = Math.max(e.from, lastRun); e.updated = now;
      e.text = String(e.text || '').replace(/\s*\(end time unknown[^)]*\)$/, '') + ' (end time unknown — the watcher did not run between ' + stamp(lastRun) + ' and ' + stamp(now) + ')';
      changes.push('closed ' + e.label + ' at last run (watcher gap)');
    }
  }
  for (const s of observed.subjects) {
    const open = log.entries.find((e) => e.auto === s.key && e.open);
    if (s.off && !open) {
      log.entries.push({
        id: 'w-' + s.key.replace(':', '-') + '-' + now.toString(36), zid: s.zid, label: s.label, zname: s.label, house: s.house, cat: s.cat,
        kind: 'offline', from: now, to: null, open: true, text: s.text, by: 'watcher', auto: s.key, created: now, updated: now
      });
      changes.push('OFFLINE ' + s.label);
    } else if (!s.off && open) {
      open.open = false; open.to = now; open.updated = now;
      changes.push('back: ' + s.label + ' after ' + Math.round((now - open.from) / 60000) + ' min');
    }
  }
  // keep it tidy: entries older than two years fall off
  log.entries = log.entries.filter((e) => e.open || (num(e.to) || num(e.from) || 0) > now - 730 * 86400000);
  log.entries.sort((a, b) => a.from - b.from);
  log.version = 1; log.updated = now; log.watcher = 'github-actions'; log.interval_min = INTERVAL_MIN;
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1) + '\n');
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    checked_at: now, checked: new Date(now).toISOString(), interval_min: INTERVAL_MIN, watcher: 'github-actions',
    units: observed.units, open: log.entries.filter((e) => e.open).map((e) => ({ label: e.label, since: e.from })),
    entries: log.entries.length
  }, null, 1) + '\n');
  return changes;
}

try {
  const observed = await observe();
  const changes = main(observed);
  const units = observed.units.map((u) => u.name + ' ' + (u.online ? 'online' : 'OFFLINE')).join(', ');
  console.log(`[offline-watch] ${new Date().toISOString()} ${units}${changes.length ? ' · ' + changes.join(' · ') : ' · no change'}`);
} catch (e) {
  // a failed run is not an outage: leave the log alone, but say why in the Actions log. Two failures in a row show up on the page
  // as a late heartbeat, which is the right signal.
  console.error('[offline-watch] failed:', e && e.message ? e.message : e);
  process.exit(1);
}
