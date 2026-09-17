/**
 * Pham's Chickens - scheduled SMS status reports
 *
 * Three texts a day, Central time:
 *   6:00a  "morning"  - recap of the 8p-6a blind window (events + temp min/max)
 *   12:00p "lunch"    - current status, short
 *   8:00p  "night"    - current status, short
 *
 * Wire into your existing Worker (see wrangler.toml and INSTALL.md).
 *
 * The zone/severity logic here is ported from the monitor page so the texts
 * and the web page agree on what counts as a problem.
 */

const API = 'https://rest.sensaphone.net/api/v1';
const TZ = 'America/Chicago';
const FARM = "PHAMS CHICKENS";

// ---------------------------------------------------------------- time

function localParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return { wd: p.weekday, mo: +p.month, day: +p.day, hour: +p.hour % 24, min: +p.minute };
}

/** Which report (if any) belongs to this cron tick. */
export function slotFor(date) {
  const h = localParts(date).hour;
  if (h === 6) return 'morning';
  if (h === 12) return 'lunch';
  if (h === 20) return 'night';
  return null;
}

function clock(ms) {
  const { hour, min } = localParts(new Date(ms));
  const ap = hour >= 12 ? 'p' : 'a';
  const h = hour % 12 || 12;
  return `${h}:${String(min).padStart(2, '0')}${ap}`;
}

function stamp(date) {
  const { wd, hour, min } = localParts(date);
  const ap = hour >= 12 ? 'p' : 'a';
  const h = hour % 12 || 12;
  return `${wd} ${h}:${String(min).padStart(2, '0')}${ap}`;
}

/** Start of the overnight window: 8:00p Central on the previous calendar day. */
function overnightStart(now) {
  const h = localParts(now).hour;
  // walk back to the most recent 20:00 local
  let t = now.getTime();
  for (let i = 0; i < 48; i++) {
    const p = localParts(new Date(t));
    if (p.hour === 20) {
      return t - p.min * 60000 - (new Date(t).getSeconds() * 1000);
    }
    t -= 3600000;
  }
  return now.getTime() - 10 * 3600000;
}

// ------------------------------------------------------- api plumbing

function seg(v) { return encodeURIComponent('{' + String(v) + '}'); }

async function api(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'text/plain' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Sensaphone returned non-JSON (HTTP ${res.status})`); }
}

async function login(env) {
  const j = await api('POST', '/login', {
    request_type: 'create', resource: 'login',
    user_name: env.SENSAPHONE_USER, password: env.SENSAPHONE_PASS
  });
  const r = j.result || {};
  if (!r.success) throw new Error(`Sensaphone login failed: ${r.message || 'code ' + r.code}`);
  const resp = j.response || {};
  return { acctid: resp.acctid, session: resp.session };
}

function basePath(a) { return '/' + seg(a.acctid) + '/' + seg(a.session); }

// ------------------------------------------------- response normalizing

function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'value')) {
    return v.is_null === true ? null : v.value;
  }
  return v;
}
function stateText(v) {
  v = unwrap(v);
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(stateText).filter(Boolean).join(', ');
  for (const k of ['state', 'zone_state', 'status', 'name', 'condition', 'description', 'value']) {
    if (v[k] != null && typeof v[k] !== 'object') return String(v[k]);
  }
  return Object.keys(v).map(k => stateText(v[k])).filter(Boolean).join(', ');
}
function asArray(v) { v = unwrap(v); return v == null ? [] : (Array.isArray(v) ? v : [v]); }
function num(v) {
  v = unwrap(v);
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.+\-eE]/g, ''));
  return isNaN(n) ? null : n;
}
function findKey(x, key, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 6) return undefined;
  if (Object.prototype.hasOwnProperty.call(x, key)) return x[key];
  for (const k of Object.keys(x)) {
    const r = findKey(x[k], key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
function collect(x, test, depth = 0, out = []) {
  if (!x || typeof x !== 'object' || depth > 6) return out;
  if (Array.isArray(x)) { x.forEach(i => collect(i, test, depth + 1, out)); return out; }
  if (test(x)) { out.push(x); return out; }
  for (const k of Object.keys(x)) collect(x[k], test, depth + 1, out);
  return out;
}
const findDevices = x => collect(x, o => o.device_id != null && (o.name != null || o.zone != null || o.type != null));
const findZones = x => collect(x, o => o.zone_id != null);

const ZONE_STATE = {
  0: '', 1: 'Alarm', 2: 'OK', 3: 'Pending', 4: 'Open', 5: 'Closed', 6: 'Cycle', 7: 'Low', 8: 'High',
  9: 'Off', 10: 'On', 11: 'Return to normal', 12: 'Route down', 13: 'Trouble', 14: 'Not responding',
  15: 'Dependency failure', 16: 'Battery', 17: 'Acknowledged', 18: 'Unacknowledged'
};
const ALARM_STATES = { 1: 1, 7: 1, 8: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 18: 1 };
const isCode = c => typeof c === 'number' || (typeof c === 'string' && /^\d+$/.test(c));
const stateWords = v => asArray(v).map(c => isCode(c) ? (ZONE_STATE[num(c)] || '') : stateText(c)).filter(Boolean).join(', ');
const hasAlarmCode = v => asArray(v).some(c => isCode(c) ? !!ALARM_STATES[num(c)] : /alarm|high|low|fail|trouble|unack/i.test(stateText(c)));
function cleanValue(v) {
  v = unwrap(v);
  return typeof v === 'string' ? v.replace(/\s+(?:O|C|Z|NZ)\s*:.*$/i, '').replace(/\\+$/, '').trim() : v;
}

function normalizeZone(z) {
  const g = k => unwrap(z[k]);
  const az = (z.alarm_zone && typeof z.alarm_zone === 'object') ? z.alarm_zone : {};
  const ga = k => unwrap(az[k]);
  return {
    zone_id: g('zone_id'),
    canonical: stateText(g('canonical_name')),
    name: stateText(g('name')) || stateText(g('canonical_name')) || ('Zone ' + g('zone_id')),
    value: cleanValue(g('value')),
    units: stateText(g('units')),
    low: num(ga('alarm_low')),
    high: num(ga('alarm_high')),
    status: stateWords(g('status')) || stateText(ga('alarm_status_str')) || stateWords(ga('alarm_status')),
    condition: stateWords(ga('alarm_condition')),
    unack: hasAlarmCode(ga('unack_alarms')),
    dashAlarm: false
  };
}

const CATS = [
  { key: 'temp', re: /^temp/i, label: 'temp' },
  { key: 'power', re: /^(power|gen)/i, label: 'pwr' },
  { key: 'water', re: /^water/i, label: 'water' },
  { key: 'controller', re: /^control/i, label: 'ctrl' },
  { key: 'feed', re: /^feed/i, label: 'feed' },
  { key: 'fill', re: /^fill/i, label: 'fill' }
];

function classify(z) {
  const n = (z.name || '').trim();
  const hm = n.match(/house\s*#?\s*(\d+)/i);
  let cat = null;
  for (const c of CATS) if (c.re.test(n)) { cat = c.key; break; }
  z.house = hm ? parseInt(hm[1], 10) : null;
  if (z.house != null) {
    if (!cat && num(z.value) != null && /f|c|°/i.test(z.units || '')) cat = 'temp';
    z.cat = cat || 'other';
    z.catLabel = cat ? CATS.find(c => c.key === cat).label
      : (n.replace(/house\s*#?\s*\d+/i, '').trim().toLowerCase() || 'input');
  } else if (/^(power|battery|lithium)/i.test(n)) {
    z.cat = 'unit'; z.catLabel = n.toLowerCase();
  } else {
    z.cat = 'loose'; z.catLabel = n.toLowerCase();
  }
  return z;
}

function severity(z) {
  const st = (z.status || '').toLowerCase();
  const cond = (z.condition || '').toLowerCase();
  const val = String(z.value == null ? '' : z.value).toLowerCase();
  const n = num(z.value);
  if (z.unack) return 'crit';
  if (/pending/.test(st) || /pending/.test(cond)) return 'warn';
  if (/alarm|high|low|fail|trouble|error|fault|not responding|dependency|route down|unack/.test(st)) return 'crit';
  if (z.dashAlarm) return 'crit';
  if (/^(ok|normal|clear)/.test(st)) {
    if (n != null && z.low != null && z.high != null && (n < z.low || n > z.high)) return 'crit';
    return 'good';
  }
  if (st === '') {
    if (n != null) {
      if (z.low != null && z.high != null) return (n < z.low || n > z.high) ? 'crit' : 'good';
      return 'good';
    }
    if (/^(ok|on|normal|closed|clear)/.test(val)) return 'good';
    if (/alarm|fail|off|open|trouble/.test(val)) return 'crit';
  }
  return 'unk';
}

// ------------------------------------------------------------ fetching

async function fetchState(auth) {
  const dj = await api('GET', basePath(auth) + '/device');
  if (!dj.result || !dj.result.success) throw new Error('Could not read device list: ' + (dj.result && dj.result.message));

  const devices = findDevices(dj.response).map(d => {
    const g = k => unwrap(d[k]);
    return {
      device_id: g('device_id'),
      name: stateText(g('name')) || 'Device',
      is_online: g('is_online'),
      last_checkin: g('last_checkin') ?? g('last_contact') ?? null,
      zones: []
    };
  });
  if (!devices.length) throw new Error('Sensaphone returned no devices for this account.');

  for (const d of devices) {
    const zj = await api('GET', basePath(auth) + '/device/' + seg(d.device_id) + '/zone');
    d.zones = findZones(zj.response).map(normalizeZone);
  }

  try {
    const dash = await api('GET', basePath(auth) + '/dashboard');
    const db = (dash && dash.response && (dash.response.dashboard || dash.response)) || null;
    if (db) {
      for (const dd of findDevices(db)) {
        const d = devices.find(x => String(x.device_id) === String(unwrap(dd.device_id)));
        if (!d) continue;
        if (dd.is_online != null) d.is_online = unwrap(dd.is_online);
        const zmap = {};
        d.zones.forEach(z => { zmap['id:' + z.zone_id] = z; });
        for (const dz of findZones(dd)) {
          const z = zmap['id:' + unwrap(dz.zone_id)];
          if (z) z.dashAlarm = true;
        }
      }
    }
  } catch { /* dashboard is best-effort */ }

  const zones = [];
  for (const d of devices) {
    for (const z of d.zones) {
      classify(z);
      z.sev = severity(z);
      z.device_id = d.device_id;
      zones.push(z);
    }
  }
  return { devices, zones };
}

// ------------------------------------------------------------- history

function sensaTs(d) {
  return d.getUTCSeconds() + d.getUTCMinutes() * 60 + d.getUTCHours() * 3600 +
    (d.getUTCDate() - 1) * 86400 + d.getUTCMonth() * 2678400 + (d.getUTCFullYear() % 100) * 32140800;
}

async function logPointMap(auth, deviceId) {
  const j = await api('GET', basePath(auth) +
    '/history/data_log_points/resource_type/' + seg('device') + '/device_id/' + seg(deviceId));
  if (!j.result || !j.result.success) return {};
  const map = {};
  for (const p of asArray(findKey(j.response, 'log_points'))) {
    if (!p || typeof p !== 'object') continue;
    const lp = unwrap(p.log_point);
    if (lp == null) continue;
    for (const k of Object.keys(p)) {
      if (/zone/i.test(k) && /id/i.test(k) && p[k] != null) map['id:' + unwrap(p[k])] = lp;
    }
  }
  return map;
}

function parseRecords(resp, sinceMs, untilMs) {
  return asArray(findKey(resp, 'data_log')).map(r => {
    if (!r || typeof r !== 'object') return null;
    let t = num(r.epoch);
    if (t == null) t = num(r.timestamp);
    if (t == null) return null;
    if (t < 1e11) t *= 1000;
    return { t, v: unwrap(r.value), alarm: unwrap(r.is_alarm) };
  }).filter(r => r && r.t >= sinceMs && r.t <= untilMs).sort((a, b) => a.t - b.t);
}

async function history(auth, lpMapCache, zone, sinceMs, untilMs) {
  if (!lpMapCache[zone.device_id]) lpMapCache[zone.device_id] = await logPointMap(auth, zone.device_id);
  const lp = lpMapCache[zone.device_id]['id:' + zone.zone_id];
  if (lp == null) return [];
  const start = new Date(sinceMs - 26 * 3600000), end = new Date(untilMs + 26 * 3600000);
  const path = '/history/data_log/log_points/' + seg(lp) +
    '/start/' + seg(sensaTs(start)) + '/end/' + seg(sensaTs(end)) +
    '/begin_offset/' + seg(0) + '/record_offset/' + seg(5000);
  const j = await api('GET', basePath(auth) + path);
  if (!j.result || !j.result.success) return [];
  return parseRecords(j.response, sinceMs, untilMs);
}

/** Collapse a record series into alarm episodes. */
function episodes(recs) {
  const out = [];
  let cur = null;
  for (const r of recs) {
    const bad = r.alarm === true || r.alarm === 1 || r.alarm === '1';
    if (bad && !cur) cur = { start: r.t, end: r.t, peak: num(r.v) };
    else if (bad && cur) {
      cur.end = r.t;
      const n = num(r.v);
      if (n != null && (cur.peak == null || Math.abs(n) > Math.abs(cur.peak))) cur.peak = n;
    } else if (!bad && cur) { cur.end = r.t; out.push(cur); cur = null; }
  }
  if (cur) { cur.open = true; out.push(cur); }
  return out;
}

// -------------------------------------------------------- report bodies

function houseLabel(n) { return 'H' + n; }

function shortStatus(zones) {
  const houses = {};
  for (const z of zones) {
    if (z.house == null) continue;
    if (!houses[z.house]) houses[z.house] = [];
    houses[z.house].push(z);
  }
  return Object.keys(houses).map(Number).sort((a, b) => a - b).map(n => ({ n, zones: houses[n] }));
}

function fmtVal(z) {
  const n = num(z.value);
  if (n != null && /f|c|°/i.test(z.units || '')) return Math.round(n) + (/(^|[^a-z])c\b/i.test(z.units) ? 'C' : 'F');
  const v = String(z.value == null ? '' : z.value).trim();
  return v.length > 10 ? v.slice(0, 10) : (v || '--');
}

function problemLines(zones) {
  return zones.filter(z => z.sev === 'crit' || z.sev === 'warn').map(z => {
    const where = z.house != null ? houseLabel(z.house) + ' ' : '';
    const what = (z.catLabel || z.name).toUpperCase();
    const val = fmtVal(z);
    const lim = (z.high != null && num(z.value) != null && num(z.value) > z.high) ? ` (limit ${Math.round(z.high)})`
      : (z.low != null && num(z.value) != null && num(z.value) < z.low) ? ` (limit ${Math.round(z.low)})` : '';
    return `${where}${what} ${val}${lim}`.trim();
  });
}

function buildCurrent(state, now, label) {
  const lines = [`${FARM}  ${stamp(now)}`];
  const probs = problemLines(state.zones);
  const houses = shortStatus(state.zones);

  if (probs.length) {
    lines.push(`${probs.length} ISSUE${probs.length > 1 ? 'S' : ''}`, '');
    probs.slice(0, 8).forEach(p => lines.push(p));
    const okHouses = houses.filter(h => !h.zones.some(z => z.sev === 'crit' || z.sev === 'warn'));
    if (okHouses.length) {
      lines.push('');
      lines.push(okHouses.map(h => {
        const t = h.zones.find(z => z.cat === 'temp');
        return `${houseLabel(h.n)} ok${t ? ' ' + fmtVal(t) : ''}`;
      }).join('   '));
    }
  } else {
    lines.push(`All ${houses.length} houses normal`, '');
    for (const h of houses) {
      const t = h.zones.find(z => z.cat === 'temp');
      const others = h.zones.filter(z => z.cat !== 'temp' && z.cat !== 'other').slice(0, 2);
      lines.push(`${houseLabel(h.n)} ${t ? fmtVal(t) : '--'}  ` +
        others.map(z => `${z.catLabel} ok`).join('  '));
    }
  }

  const offline = state.devices.filter(d => d.is_online === false || d.is_online === 0);
  if (offline.length) lines.push('', `!! DEVICE OFFLINE: ${offline.map(d => d.name).join(', ')}`);
  return lines.join('\n');
}

function buildMorning(state, now, sinceMs, hist) {
  const lines = [`${FARM}  ${stamp(now)}`, `OVERNIGHT ${clock(sinceMs)}-${clock(now.getTime())}`, ''];

  const evs = [];
  for (const { zone, recs } of hist) {
    for (const e of episodes(recs)) {
      const mins = Math.max(1, Math.round((e.end - e.start) / 60000));
      evs.push({ t: e.start, open: e.open, text:
        `${clock(e.start)} ${zone.house != null ? houseLabel(zone.house) + ' ' : ''}` +
        `${zone.catLabel || zone.name}` +
        `${e.peak != null ? ' ' + Math.round(e.peak) : ''}, ${mins}m${e.open ? ' ONGOING' : ''}` });
    }
  }
  evs.sort((a, b) => a.t - b.t);

  if (evs.length) {
    const open = evs.filter(e => e.open).length;
    lines.push(`${evs.length} event${evs.length > 1 ? 's' : ''}` +
      (open ? `, ${open} ONGOING` : ', all cleared'));
    evs.slice(0, 8).forEach(e => lines.push(' ' + e.text));
    if (evs.length > 8) lines.push(` +${evs.length - 8} more`);
  } else {
    lines.push('No events overnight');
  }

  const temps = hist.filter(h => h.zone.cat === 'temp' && h.recs.length);
  if (temps.length) {
    lines.push('', 'Temp low/high');
    const chunks = temps.map(({ zone, recs }) => {
      const vals = recs.map(r => num(r.v)).filter(v => v != null);
      if (!vals.length) return null;
      return ` ${zone.house != null ? houseLabel(zone.house) : zone.name.slice(0, 6)} ` +
        `${Math.round(Math.min(...vals))}/${Math.round(Math.max(...vals))}`;
    }).filter(Boolean);
    for (let i = 0; i < chunks.length; i += 2) lines.push(chunks.slice(i, i + 2).join('  '));
  }

  const probs = problemLines(state.zones);
  lines.push('');
  if (probs.length) {
    lines.push('NOW: ' + probs.length + ' open');
    probs.slice(0, 4).forEach(p => lines.push(' ' + p));
  } else {
    lines.push(`NOW: all ${shortStatus(state.zones).length} normal`);
  }

  const offline = state.devices.filter(d => d.is_online === false || d.is_online === 0);
  if (offline.length) lines.push(`!! DEVICE OFFLINE: ${offline.map(d => d.name).join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- twilio

async function sendSms(env, body) {
  const to = String(env.SMS_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) throw new Error('SMS_TO is empty');
  const text = body.length > 1200 ? body.slice(0, 1190) + '\n...trunc' : body;
  const results = [];
  for (const num of to) {
    const form = new URLSearchParams({ To: num, From: env.TWILIO_FROM, Body: text });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form
      }
    );
    const j = await res.json().catch(() => ({}));
    results.push({ to: num, ok: res.ok, sid: j.sid, error: j.message });
  }
  return results;
}


// ---------------------------------------------------------- node entry

/**
 * Decide the slot from the cron expression GitHub says fired, not from the
 * clock at run time. Actions can be minutes-to-half-an-hour late, and using
 * the intended time keeps a late run from being skipped or misfiled.
 */
function slotFromSchedule(expr, now = new Date()) {
  const m = String(expr || '').trim().split(/\s+/);
  if (m.length < 2) return slotFor(now);
  const utcHour = parseInt(m[1], 10);
  if (isNaN(utcHour)) return slotFor(now);

  // the intended instant: today (UTC) at that hour, nearest to now
  const intended = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
  const candidates = [intended,
    new Date(intended.getTime() - 86400000),
    new Date(intended.getTime() + 86400000)];
  candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
  return slotFor(candidates[0]);
}

async function buildReport(env, slot, now = new Date()) {
  const auth = await login(env);
  const state = await fetchState(auth);

  if (slot !== 'morning') return buildCurrent(state, now, slot);

  const sinceMs = overnightStart(now);
  const untilMs = now.getTime();
  const lpCache = {};
  const watch = state.zones.filter(z => z.house != null &&
    (z.cat === 'temp' || z.cat === 'power' || z.cat === 'water' || z.cat === 'controller'));
  const hist = [];
  for (const z of watch) {
    try { hist.push({ zone: z, recs: await history(auth, lpCache, z, sinceMs, untilMs) }); }
    catch { /* one bad zone shouldn't kill the whole report */ }
  }
  return buildMorning(state, now, sinceMs, hist);
}

async function main() {
  const env = process.env;
  const now = new Date();
  const arg = process.argv[2];

  // preview <slot>  -> print only, send nothing (safe any time)
  // send <slot>     -> build that slot now and actually text it
  // (no args)       -> scheduled run; slot comes from the cron that fired
  const preview = arg === 'preview' || env.PREVIEW === '1';
  const forced = (arg === 'preview' || arg === 'send') ? (process.argv[3] || 'morning') : null;
  let slot = forced || slotFromSchedule(env.SCHEDULE, now);

  if (!slot) {
    console.log(`No slot for schedule "${env.SCHEDULE}" - this is the wrong DST half, exiting quietly.`);
    return;
  }

  let body;
  try {
    body = await buildReport(env, slot, now);
  } catch (err) {
    body = `${FARM}  ${stamp(now)}\nREPORT FAILED\n${String(err && err.message || err).slice(0, 200)}`;
    console.error('build failed:', err);
  }

  console.log('--- ' + slot + ' ---\n' + body + '\n---');
  if (preview) { console.log('(preview - nothing sent)'); return; }

  const results = await sendSms(env, body);
  for (const r of results) {
    console.log(r.ok ? `sent to ${r.to} (${r.sid})` : `FAILED to ${r.to}: ${r.error}`);
  }
  if (results.some(r => !r.ok)) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
