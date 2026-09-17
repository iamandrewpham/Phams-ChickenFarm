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

const ICON = {
  temp: '\u{1F321}', power: '\u26A1', water: '\u{1F4A7}', controller: '\u2699',
  feed: '\u{1F33E}', fill: '\u{1F6E2}', other: '\u{1F538}', unit: '\u{1F50C}', loose: '\u{1F538}'
};
const HOT = '\u{1F525}';
const OK = '\u2705', ALERT = '\u{1F6A8}', WARN = '\u26A0\uFE0F',
      NIGHT = '\u{1F319}', OFFLINE = '\u{1F4F5}', CHICK = '\u{1F414}';

function houseLabel(n) { return 'H' + n; }

function head(now) { return `${CHICK} PHAM'S \u00B7 ${stamp(now)}`; }

function shortStatus(zones) {
  const houses = {};
  for (const z of zones) {
    if (z.house == null) continue;
    (houses[z.house] = houses[z.house] || []).push(z);
  }
  return Object.keys(houses).map(Number).sort((a, b) => a - b).map(n => ({ n, zones: houses[n] }));
}

function fmtVal(z) {
  const n = num(z.value);
  if (n != null && /f|c|\u00B0/i.test(z.units || '')) return Math.round(n) + '\u00B0';
  const v = String(z.value == null ? '' : z.value).trim();
  return v.length > 10 ? v.slice(0, 10) : (v || '--');
}

function iconFor(z) {
  if (z.cat === 'temp') {
    const n = num(z.value);
    if (n != null && z.high != null && n > z.high) return HOT;
  }
  return ICON[z.cat] || ICON.other;
}

function problemLines(zones) {
  return zones.filter(z => z.sev === 'crit' || z.sev === 'warn').map(z => {
    const where = z.house != null ? houseLabel(z.house) + ' ' : '';
    const val = fmtVal(z);
    const n = num(z.value);
    let lim = '';
    if (n != null && z.high != null && n > z.high) lim = ' \u2014 max ' + Math.round(z.high);
    else if (n != null && z.low != null && n < z.low) lim = ' \u2014 min ' + Math.round(z.low);
    const label = z.cat === 'temp' ? '' : String(z.catLabel || z.name);
    // don't print the label when the value already says the same thing
    const dup = label && String(val).toLowerCase().includes(label.toLowerCase());
    const body = (label && !dup) ? `${label} ${val}` : `${val}`;
    return `${iconFor(z)} ${where}${body}${lim}`.replace(/\s+/g, ' ').trim();
  });
}

function buildCurrent(state, now, wx) {
  const lines = [head(now)];
  const probs = problemLines(state.zones);
  const houses = shortStatus(state.zones);

  if (probs.length) {
    lines.push(`${ALERT} ${probs.length} ISSUE${probs.length > 1 ? 'S' : ''}`, '');
    probs.slice(0, 8).forEach(p => lines.push(p));
    const ok = houses.filter(h => !h.zones.some(z => z.sev === 'crit' || z.sev === 'warn'));
    if (ok.length) {
      lines.push('');
      const cells = ok.map(h => {
        const t = h.zones.find(z => z.cat === 'temp');
        return `${OK} ${houseLabel(h.n)}${t ? ' ' + fmtVal(t) : ''}`;
      });
      for (let i = 0; i < cells.length; i += 2) lines.push(cells.slice(i, i + 2).join('   '));
    }
  } else {
    lines.push(`${OK} All ${houses.length} houses OK`, '');
    const cells = houses.map(h => {
      const t = h.zones.find(z => z.cat === 'temp');
      return `${houseLabel(h.n)} ${t ? fmtVal(t) : '--'}`;
    });
    for (let i = 0; i < cells.length; i += 2) {
      lines.push(ICON.temp + ' ' + cells.slice(i, i + 2).join('  '));
    }
    const cats = ['power', 'water', 'controller', 'feed'];
    const row = [];
    for (const c of cats) {
      const any = state.zones.filter(z => z.cat === c);
      if (any.length) row.push(`${ICON[c]} ${c === 'power' ? 'Power' : c === 'water' ? 'Water'
        : c === 'controller' ? 'Ctrl' : 'Feed'} OK`);
    }
    if (row.length) lines.push(row.slice(0, 2).join('   '));
  }

  const wl = weatherLines(wx, state.__slot);
  if (wl.length) lines.push('', ...wl);

  const offline = state.devices.filter(d => d.is_online === false || d.is_online === 0);
  if (offline.length) lines.push('', `${OFFLINE} OFFLINE: ${offline.map(d => d.name).join(', ')}`);
  else {
    const last = state.devices.map(d => num(d.last_checkin)).filter(v => v != null)[0];
    if (last != null) lines.push('', 'Last check ' + clock(last < 1e11 ? last * 1000 : last));
  }
  return lines.join('\n');
}

function buildMorning(state, now, sinceMs, hist, wx) {
  const lines = [head(now), `${NIGHT} Overnight ${clock(sinceMs)}\u2013${clock(now.getTime())}`, ''];

  const evs = [];
  for (const { zone, recs } of hist) {
    for (const e of episodes(recs)) {
      const mins = Math.max(1, Math.round((e.end - e.start) / 60000));
      const ic = zone.cat === 'temp' ? HOT : (ICON[zone.cat] || ICON.other);
      const what = zone.cat === 'temp'
        ? (e.peak != null ? Math.round(e.peak) + '\u00B0' : 'temp')
        : (zone.catLabel || zone.name);
      evs.push({ t: e.start, open: e.open, text:
        `  ${clock(e.start)} ${ic} ${zone.house != null ? houseLabel(zone.house) + ' ' : ''}` +
        `${what} \u00B7 ${mins}m${e.open ? ' \u2014 ONGOING' : ''}` });
    }
  }
  evs.sort((a, b) => a.t - b.t);

  if (evs.length) {
    const open = evs.filter(e => e.open).length;
    lines.push(`${WARN} ${evs.length} event${evs.length > 1 ? 's' : ''} \u00B7 ` +
      (open ? `${open} ONGOING` : 'all cleared'));
    evs.slice(0, 7).forEach(e => lines.push(e.text));
    if (evs.length > 7) lines.push(`  +${evs.length - 7} more`);
  } else {
    lines.push(`${OK} No events overnight`);
  }

  const temps = hist.filter(h => h.zone.cat === 'temp' && h.recs.length);
  if (temps.length) {
    lines.push('', ICON.temp + ' Low\u2013high');
    temps.sort((a, b) => (a.zone.house ?? 99) - (b.zone.house ?? 99));
    const cells = temps.map(({ zone, recs }) => {
      const vals = recs.map(r => num(r.v)).filter(v => v != null);
      if (!vals.length) return null;
      const lbl = zone.house != null ? houseLabel(zone.house) : zone.name.slice(0, 6);
      return `${lbl} ${Math.round(Math.min(...vals))}\u2013${Math.round(Math.max(...vals))}`;
    }).filter(Boolean);
    for (let i = 0; i < cells.length; i += 2) lines.push('  ' + cells.slice(i, i + 2).join('   '));
  }

  const probs = problemLines(state.zones);
  lines.push('');
  if (probs.length) {
    lines.push(`${ALERT} Now: ${probs.length} open`);
    probs.slice(0, 4).forEach(p => lines.push('  ' + p));
  } else {
    const last = state.devices.map(d => num(d.last_checkin)).filter(v => v != null)[0];
    lines.push(`${OK} Now: all normal` + (last != null
      ? ' \u00B7 ' + clock(last < 1e11 ? last * 1000 : last) : ''));
  }

  const wl = weatherLines(wx, 'morning');
  if (wl.length) lines.push('', ...wl);

  const offline = state.devices.filter(d => d.is_online === false || d.is_online === 0);
  if (offline.length) lines.push(`${OFFLINE} OFFLINE: ${offline.map(d => d.name).join(', ')}`);
  return lines.join('\n');
}

// --------------------------------------------------------------- weather

// Open-Meteo: free, no API key, no account. Override via env if the farm moves.
const LAT = process.env.FARM_LAT || '32.7476';   // 1875 Goshen Rd, Carthage MS
const LON = process.env.FARM_LON || '-89.5342';

async function fetchWeather() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LAT}&longitude=${LON}`
    + '&hourly=temperature_2m,dew_point_2m,cloud_cover,wind_speed_10m,precipitation_probability'
    + '&daily=temperature_2m_max,temperature_2m_min'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph'
    + '&timezone=America%2FChicago&forecast_days=2';
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather HTTP ' + res.status);
  return res.json();
}

/** Pull the hourly rows for a local-time window, [startHour, endHour) from dayOffset. */
function hourlySlice(w, dayOffset, startHour, endHour) {
  const out = [];
  const h = w.hourly;
  for (let i = 0; i < h.time.length; i++) {
    const [d, t] = h.time[i].split('T');
    const hr = parseInt(t.slice(0, 2), 10);
    const day = w.daily.time.indexOf(d);
    if (day !== dayOffset) continue;
    if (hr < startHour || hr >= endHour) continue;
    out.push({
      hr,
      temp: h.temperature_2m[i], dew: h.dew_point_2m[i],
      cloud: h.cloud_cover[i], wind: h.wind_speed_10m[i],
      pop: h.precipitation_probability[i]
    });
  }
  return out;
}

const r0 = v => (v == null ? null : Math.round(v));

/**
 * Turn the forecast into one "what to watch" line.
 * The reasoning behind each threshold is written up in
 * docs/why-house-temps-move.md - read that before changing numbers.
 */
function weatherLines(w, slot) {
  if (!w) return [];
  const lines = [];
  const maxT = r0(w.daily.temperature_2m_max[0]);
  const minT = r0(w.daily.temperature_2m_min[0]);

  if (slot === 'night') {
    const night = hourlySlice(w, 0, 20, 24).concat(hourlySlice(w, 1, 0, 7));
    const lowT = night.length ? r0(Math.min(...night.map(x => x.temp))) : r0(w.daily.temperature_2m_min[1]);
    const cloud = night.length ? Math.min(...night.map(x => x.cloud)) : null;
    const wind = night.length ? Math.min(...night.map(x => x.wind)) : null;
    const clearCalm = cloud != null && cloud < 30 && wind != null && wind < 5;
    lines.push(`\u{1F321} Tonight low ${lowT}\u00B0` + (clearCalm ? ' \u00B7 clear & calm' : ''));
    if (clearCalm) {
      lines.push('\u26A0\uFE0F Radiant cooling \u2014 houses drop faster than outside');
    }
    const gust = night.length ? Math.max(...night.map(x => x.wind)) : 0;
    if (gust >= 18) lines.push(`\u{1F4A8} Wind to ${r0(gust)}mph \u2014 check curtains/inlets`);
    return lines;
  }

  // morning + lunch: today ahead
  const day = hourlySlice(w, 0, 10, 20);
  const peakDew = day.length ? r0(Math.max(...day.map(x => x.dew))) : null;
  const gust = day.length ? r0(Math.max(...day.map(x => x.wind))) : 0;
  const pop = day.length ? Math.max(...day.map(x => x.pop)) : 0;

  lines.push(`\u{1F324} Today ${minT}\u2013${maxT}\u00B0`);

  if (maxT != null && maxT >= 95) {
    lines.push('\u{1F525} Severe heat \u2014 full tunnel + cool cells, watch water use');
  } else if (maxT != null && maxT >= 88) {
    lines.push('\u2600\uFE0F Heat load builds 2\u20136p \u2014 stage fans early');
  }
  if (maxT != null && maxT >= 88 && peakDew != null && peakDew >= 72) {
    lines.push(`\u{1F4A6} Dew pt ${peakDew}\u00B0 \u2014 cool cells lose bite, lean on air speed`);
  }
  if (pop >= 60) lines.push(`\u{1F327} Rain ${pop}% \u2014 humidity up, litter damp`);
  if (gust >= 20) lines.push(`\u{1F4A8} Wind to ${gust}mph \u2014 check curtains/inlets`);
  return lines;
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
  state.__slot = slot;

  // weather is a nice-to-have; a forecast outage must not cost us the report
  let wx = null;
  try { wx = await fetchWeather(); }
  catch (err) { console.error('weather unavailable:', err.message); }

  if (slot !== 'morning') return buildCurrent(state, now, wx);

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
  return buildMorning(state, now, sinceMs, hist, wx);
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
