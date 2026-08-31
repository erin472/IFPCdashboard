'use strict';
const fs = require('fs');
const path = require('path');

function floorToMinuteUtc(ms) {
  return Math.floor(ms / 60000);
}

function formatPlantLocalNaive(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour; // belt-and-suspenders for ICU quirks
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}

function pointsToValues(points, startMinUtc, endMinUtc) {
  const n = endMinUtc - startMinUtc + 1;
  const values = new Array(n).fill(null);
  if (!Array.isArray(points)) return values;
  for (const p of points) {
    if (!p || p.from == null) continue;
    const fromMs = typeof p.from === 'number' ? p.from : Date.parse(p.from);
    if (!Number.isFinite(fromMs)) continue;
    const i = floorToMinuteUtc(fromMs) - startMinUtc;
    if (i < 0 || i >= n) continue;
    const v = p.avg == null ? NaN : Number(p.avg);
    values[i] = Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  return values;
}

function mergeSensorSeries(existing, fresh, historyMinutes) {
  const series = [existing, fresh].filter((s) => s && Array.isArray(s.values) && s.values.length);
  if (series.length === 0) return { startMinUtc: (fresh && fresh.startMinUtc) || 0, values: [] };
  const start = Math.min(...series.map((s) => s.startMinUtc));
  const end = Math.max(...series.map((s) => s.startMinUtc + s.values.length - 1));
  const merged = new Array(end - start + 1).fill(null);
  // Lower priority first (existing), then fresh overrides where non-null.
  for (const s of [existing, fresh]) {
    if (!s || !Array.isArray(s.values)) continue;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (v != null) merged[s.startMinUtc - start + i] = v;
    }
  }
  const keepFrom = Math.max(0, merged.length - historyMinutes);
  return { startMinUtc: start + keepFrom, values: merged.slice(keepFrom) };
}

const SENSOR_META = {
  temperature: { name: 'Temperature (F)', location: '', type: 'temperature', unit: '°F', spec: { min: 65, max: 70 }, flag: true },
  humidity:    { name: 'Humidity (%)',    location: '', type: 'humidity',    unit: '% RH', spec: { max: 40 },        flag: true },
};
const SENSOR_KEYS = ['temperature', 'humidity'];

let _syncInFlight = false;

const SENTINEL_START = '/* GW_SENSOR_DATA_START */';
const SENTINEL_END = '/* GW_SENSOR_DATA_END */';

function toDashboardData(model, tz) {
  const sensors = (model.sensors || []).filter((s) => SENSOR_META[s.key]).map((s) => {
    const meta = SENSOR_META[s.key];
    return {
      name: meta.name, location: meta.location, type: meta.type, unit: meta.unit,
      spec: meta.spec, flag: meta.flag,
      start: formatPlantLocalNaive(s.startMinUtc * 60000, tz),
      stepMin: 1,
      values: s.values,
    };
  });
  return {
    sensors,
    isPlaceholder: false,
    lastSync: (model.meta && model.meta.lastSuccessfulSync != null)
      ? formatPlantLocalNaive(model.meta.lastSuccessfulSync, tz) : null,
    throughTs: (model.meta && model.meta.throughMinUtc != null) ? model.meta.throughMinUtc : null,
  };
}

function escapeForScript(s) {
  return String(s)
    .replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function injectSensorData(html, dashboardData) {
  const re = new RegExp(escapeRegExp(SENTINEL_START) + '[\\s\\S]*?' + escapeRegExp(SENTINEL_END));
  if (!re.test(html)) throw new Error('sensorData sentinel markers not found in dashboard.html');
  const json = escapeForScript(JSON.stringify(dashboardData));
  return html.replace(re, `${SENTINEL_START} var sensorData = ${json}; ${SENTINEL_END}`);
}

function resolveAuthTarget(env) {
  if (env.GUIDEWHEEL_API_URL && env.GUIDEWHEEL_API_KEY && env.COMPANY_ID) {
    const baseUrl = env.GUIDEWHEEL_API_URL.replace(/\/$/, '');
    return {
      mode: 'public',
      baseUrl,
      prefix: /\/v1$/.test(baseUrl) ? '' : '/v1', // tolerate a base URL that already ends in /v1
      companyId: env.COMPANY_ID,
      headers: {},
      queryAuth: { api_key: env.GUIDEWHEEL_API_KEY },
    };
  }
  if (env.SAFI_API_URL) {
    let headers = null;
    if (env.SAFI_API_KEY) headers = { 'x-api-key': env.SAFI_API_KEY };
    else if (env.SAFI_JWT) headers = { Authorization: `Bearer ${env.SAFI_JWT.replace(/^Bearer\s+/i, '')}` };
    if (headers) {
      return {
        mode: 'internal',
        baseUrl: env.SAFI_API_URL.replace(/\/$/, ''),
        prefix: '',
        companyId: env.COMPANY_ID || '',
        headers,
        queryAuth: null,
      };
    }
  }
  return null;
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

function chunkRange(fromMs, toMs, maxMs = SIX_DAYS_MS) {
  const out = [];
  for (let cur = fromMs; cur < toMs; cur += maxMs) out.push({ from: cur, to: Math.min(cur + maxMs, toMs) });
  return out;
}

async function fetchJsonWithRetry(fetchImpl, url, headers, sleep) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (res.status === 429 && attempt < 3) {
      const ra = res.headers && res.headers.get && res.headers.get('retry-after');
      const raN = Number(ra);
      await wait(Number.isFinite(raN) ? raN * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Guidewheel telemetry ${res.status}: ${await res.text()}`), { status: res.status });
    return res.json();
  }
}

async function gwTelemetry({ fetchImpl, target, deviceId, metric, fromMs, toMs, sleep }) {
  const all = [];
  for (const c of chunkRange(fromMs, toMs)) {
    const url = new URL(`${target.baseUrl}${target.prefix}/devices/${encodeURIComponent(deviceId)}/telemetry`);
    url.searchParams.set('metric', metric);
    url.searchParams.set('granularity', 'minute');
    url.searchParams.set('from', new Date(c.from).toISOString());
    url.searchParams.set('to', new Date(c.to).toISOString());
    if (target.companyId) url.searchParams.set('company_id', target.companyId);
    if (target.queryAuth) for (const [k, v] of Object.entries(target.queryAuth)) url.searchParams.set(k, v);
    const data = await fetchJsonWithRetry(fetchImpl, url, target.headers, sleep);
    const points = (data && data.data && data.data.points) || [];
    all.push(...points);
  }
  return all;
}

function clampNum(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function readConfig(env) {
  return {
    tempMetric: env.GW_TEMP_METRIC || 'TempF',
    humidityMetric: env.GW_HUMIDITY_METRIC || '',
    tempDeviceId: env.GW_TEMP_DEVICE_ID || env.GW_DEVICE_ID || '',
    humidityDeviceId: env.GW_HUMIDITY_DEVICE_ID || env.GW_DEVICE_ID || '',
    historyDays: clampNum(env.GW_HISTORY_DAYS, 30, 1, 3650),
    syncIntervalMinutes: clampNum(env.GW_SYNC_INTERVAL_MINUTES, 60, 1, 1440),
    plantTz: env.PLANT_TZ || 'America/Chicago',
  };
}

function existingSeriesFor(model, key) {
  if (!model || !Array.isArray(model.sensors)) return null;
  const s = model.sensors.find((x) => x.key === key);
  return s ? { startMinUtc: s.startMinUtc, values: s.values } : null;
}

async function syncOnce(deps, mode = 'full') {
  if (_syncInFlight) {
    (deps.log || (() => {}))('sensor.sync.busy', { mode });
    return { ok: false, reason: 'busy', warnings: [] };
  }
  _syncInFlight = true;
  try {
    const { env, fetchImpl, now, store, log, onUpdate } = deps;
    const target = resolveAuthTarget(env);
    if (!target) { log('sensor.sync.skip_no_creds', { mode }); return { ok: false, reason: 'no_creds', warnings: [] }; }

    const cfg = readConfig(env);
    const prev = store.read();
    const nowMs = now();
    const historyMinutes = Math.round(cfg.historyDays * 1440);
    const overlapMs = 2 * 60 * 60 * 1000;
    const prevThrough = prev && prev.meta ? prev.meta.throughMinUtc : null;
    const toMs = nowMs;
    const windowFloorMs = nowMs - cfg.historyDays * 86400000;
    const rawFromMs = (mode === 'incremental' && prevThrough != null)
      ? prevThrough * 60000 - overlapMs
      : windowFloorMs;
    const fromMs = Math.min(Math.max(rawFromMs, windowFloorMs), toMs);
    const startMinUtc = floorToMinuteUtc(fromMs);
    const endMinUtc = floorToMinuteUtc(toMs);

    const metricFor = { temperature: cfg.tempMetric, humidity: cfg.humidityMetric };
    const deviceFor = { temperature: cfg.tempDeviceId, humidity: cfg.humidityDeviceId };
    const warnings = [];
    const sensors = [];
    let anyFresh = false;

    try {
      for (const key of SENSOR_KEYS) {
        const metric = metricFor[key];
        const deviceId = deviceFor[key];
        const existing = existingSeriesFor(prev, key);
        if (!metric || !deviceId) {
          warnings.push(`${key}: no metric/device configured — skipped`);
          sensors.push(existing ? { key, ...mergeSensorSeries(existing, null, historyMinutes) } : { key, startMinUtc: endMinUtc, values: [] });
          continue;
        }
        const points = await gwTelemetry({ fetchImpl, target, deviceId, metric, fromMs, toMs });
        const freshValues = pointsToValues(points, startMinUtc, endMinUtc);
        const allNull = freshValues.every((v) => v == null);
        if (allNull) {
          warnings.push(`${key}: telemetry returned all-null points — retained existing`);
          sensors.push(existing ? { key, ...mergeSensorSeries(existing, null, historyMinutes) } : { key, startMinUtc: endMinUtc, values: [] });
          continue;
        }
        anyFresh = true;
        const merged = mergeSensorSeries(existing, { startMinUtc, values: freshValues }, historyMinutes);
        sensors.push({ key, startMinUtc: merged.startMinUtc, values: merged.values });
      }
    } catch (err) {
      const reason = (err && (err.status === 401 || err.status === 403)) ? 'auth_error' : 'fetch_error';
      log(`sensor.sync.${reason}`, { mode, status: err && err.status, message: err.message });
      return { ok: false, reason, warnings };
    }

    // Defensive: SENSOR_KEYS is non-empty so this is unreachable in practice, but it guards against an empty model.
    if (sensors.length === 0) {
      log('sensor.sync.no_data', { mode, warnings });
      return { ok: false, reason: 'no_data', warnings };
    }

    if (!anyFresh) {
      log('sensor.sync.no_new_data', { mode, warnings });
      return { ok: false, reason: 'no_new_data', warnings };
    }

    const ends = sensors.filter((s) => s.values.length).map((s) => s.startMinUtc + s.values.length - 1);
    const throughMinUtc = ends.length ? Math.max(...ends) : endMinUtc;
    const model = {
      sensors,
      meta: {
        lastSuccessfulSync: nowMs,
        throughMinUtc,
        mode,
        metrics: { temperature: cfg.tempMetric, humidity: cfg.humidityMetric },
      },
    };
    store.write(model);
    onUpdate(model);
    log('sensor.sync.ok', { mode, throughMinUtc, warnings });
    return { ok: true, model, throughMinUtc, warnings };
  } finally {
    _syncInFlight = false;
  }
}

function startScheduler(deps) {
  const setI = deps.setIntervalImpl || setInterval;
  const run = deps._syncOnce || syncOnce; // _syncOnce is a test seam
  const cfg = readConfig(deps.env);
  const log = deps.log || (() => {});

  // Boot: rebuild the full window so a restart/redeploy self-heals.
  Promise.resolve(run(deps, 'full')).catch((e) => log('sensor.sync.boot_error', { message: e.message }));

  // Then top up incrementally on a fixed interval (hourly by default).
  const intervalHandle = setI(() => {
    Promise.resolve(run(deps, 'incremental')).catch((e) => log('sensor.sync.tick_error', { message: e.message }));
  }, cfg.syncIntervalMinutes * 60 * 1000);

  return { stop() { clearInterval(intervalHandle); } };
}

function createFileStore(filePath) {
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
    },
    write(model) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(model), 'utf8');
      } catch (e) { /* best-effort cache; ignore disk errors */ void e; }
    },
  };
}

module.exports = { floorToMinuteUtc, formatPlantLocalNaive, pointsToValues, mergeSensorSeries, SENSOR_META, SENSOR_KEYS, toDashboardData, escapeForScript, injectSensorData, resolveAuthTarget, chunkRange, gwTelemetry, readConfig, syncOnce, startScheduler, createFileStore };
