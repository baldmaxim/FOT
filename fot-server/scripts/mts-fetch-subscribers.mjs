#!/usr/bin/env node
// Диагностический standalone-скрипт: подключение к МТС «Мобильные сотрудники»
// (M-Poisk REST v6) по статическому Bearer-токену и выгрузка ВСЕХ доступных
// данных по абонентам. Без зависимостей от БД и encryptionService —
// токен принимается через CLI/env. Контракт: docs/mts-mobile-staff-api.md.
//
// Запуск:
//   node fot-server/scripts/mts-fetch-subscribers.mjs --token=<JWE>
//   MTS_API_TOKEN=<JWE> node fot-server/scripts/mts-fetch-subscribers.mjs
//   node fot-server/scripts/mts-fetch-subscribers.mjs --token=... --days=7 --per-subscriber
//
// Опции:
//   --token=<...>        Bearer-токен МТС (или $MTS_API_TOKEN)
//   --base-url=<...>     override (default: $MTS_API_BASE_URL или https://api.mpoisk.ru/v6/api)
//   --out=<dir>          куда писать JSON (default: ./data/mts)
//   --days=N             окно для locations/tracks (default 1; включая GPS)
//   --per-subscriber     дополнительно дёргать GET /subscribers/{id} по каждому
//                        (медленно, но даёт все поля + customTemplateItems)
//   --no-locations       не тянуть locations/tracks/GPS
//   --no-save            не писать файлы, только консольный вывод
//   -h, --help

import axios from 'axios';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_BASE_URL = 'https://api.mpoisk.ru/v6/api';
const TIMEOUT_MS = 30_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
// Контракт МТС: ≤200 элементов в LBS-выборках, ≤1000 в GPS (коды 66/67).
const LBS_PAGE_SIZE = 200;
const GPS_PAGE_SIZE = 1000;
const MAX_PAGES = 25; // защита от бесконечной пагинации

function parseArgs(argv) {
  const out = { save: true, days: 1, perSubscriber: false, locations: true };
  for (const raw of argv.slice(2)) {
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const val = eq === -1 ? true : raw.slice(eq + 1);
    if (key === '--token') out.token = String(val);
    else if (key === '--base-url') out.baseUrl = String(val);
    else if (key === '--out') out.outDir = String(val);
    else if (key === '--days') out.days = Math.max(0, Number(val) || 0);
    else if (key === '--per-subscriber') out.perSubscriber = true;
    else if (key === '--no-locations') out.locations = false;
    else if (key === '--no-save') out.save = false;
    else if (key === '--help' || key === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Использование:
  node fot-server/scripts/mts-fetch-subscribers.mjs --token=<JWE> [опции]
  MTS_API_TOKEN=<JWE> node fot-server/scripts/mts-fetch-subscribers.mjs [опции]

Опции:
  --token=<...>        Bearer-токен МТС (приоритетнее $MTS_API_TOKEN)
  --base-url=<...>     default: $MTS_API_BASE_URL или ${DEFAULT_BASE_URL}
  --out=<dir>          куда писать JSON (default: ./data/mts)
  --days=N             окно для locations/tracks/GPS (default 1)
  --per-subscriber     детальный GET по каждому абоненту (медленно)
  --no-locations       не тянуть locations/tracks/GPS
  --no-save            не писать файлы
  -h, --help           помощь`);
}

function isRetryable(error) {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status && RETRY_STATUSES.has(error.response.status)) return true;
  if (error.code && RETRY_CODES.has(error.code)) return true;
  return false;
}

function describeError(error) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    const body = error.response?.data || {};
    return {
      httpStatus: status,
      code: body.code,
      description: body.description,
      message: body.message || error.message,
      validationErrors: body.validationErrors,
    };
  }
  return { httpStatus: 0, message: error?.message || String(error) };
}

function fmtError(err) {
  return `HTTP ${err.httpStatus}` +
    (err.code !== undefined ? `, code=${err.code}` : '') +
    (err.description ? `, ${err.description}` : '') +
    `, ${err.message}`;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'items', 'content', 'results']) {
      const v = payload[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

async function requestWithRetry(client, method, endpoint, options = {}) {
  let attempt = 0;
  let lastError;
  while (attempt <= RETRY_ATTEMPTS) {
    try {
      const response = await client.request({ method, url: endpoint, ...options });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_ATTEMPTS || !isRetryable(error)) throw error;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[mts] retry ${attempt + 1}/${RETRY_ATTEMPTS} ${method.toUpperCase()} ${endpoint} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastError;
}

// Универсальный fetch одного эндпоинта с логированием. fatal=true → exit при ошибке,
// иначе возвращает { ok:false, error } и скрипт продолжает.
async function fetchEndpoint(client, label, method, path, { params, data, fatal = false } = {}) {
  process.stdout.write(`[mts] ${method.toUpperCase()} ${path} … `);
  const t0 = Date.now();
  try {
    const payload = await requestWithRetry(client, method, path, { params, data });
    const items = extractItems(payload);
    const durationMs = Date.now() - t0;
    console.log(`ok (${items.length} элементов, ${durationMs} ms)`);
    return { ok: true, label, method, path, params: params ?? null, durationMs, count: items.length, items, raw: payload };
  } catch (error) {
    const err = describeError(error);
    console.log(`FAIL (${fmtError(err)})`);
    if (fatal) process.exit(1);
    return { ok: false, label, method, path, params: params ?? null, durationMs: Date.now() - t0, error: err };
  }
}

// Пагинация LBS-эндпоинтов по lastLocationID/lastTrackID. На входе:
// path, baseParams, lastIdField (например 'lastLocationID'), idField ('locationID').
async function fetchPaged(client, label, path, baseParams, lastIdField, idField, pageSize) {
  const all = [];
  const pages = [];
  let lastId = null;
  let lastError = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = { ...baseParams, count: pageSize };
    if (lastId !== null) params[lastIdField] = lastId;
    const res = await fetchEndpoint(client, `${label}#page${i + 1}`, 'get', path, { params });
    if (!res.ok) { lastError = res.error; break; }
    pages.push({ page: i + 1, durationMs: res.durationMs, count: res.count, params });
    all.push(...res.items);
    if (res.count < pageSize) break;
    const last = res.items[res.items.length - 1];
    const nextId = last?.[idField];
    if (nextId == null) break;
    lastId = nextId;
  }
  return { label, path, pages, totalCount: all.length, items: all, error: lastError };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const token = args.token || process.env.MTS_API_TOKEN;
  if (!token) {
    console.error('Ошибка: не передан Bearer-токен МТС.\n');
    printHelp();
    process.exit(1);
  }

  const baseUrl = (args.baseUrl || process.env.MTS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const tokenPreview = `${token.slice(0, 8)}…(${token.length} chars)`;

  console.log(`[mts] base URL: ${baseUrl}`);
  console.log(`[mts] token:    ${tokenPreview}`);
  console.log(`[mts] days:     ${args.days} (для locations/tracks/GPS)`);
  console.log(`[mts] per-sub:  ${args.perSubscriber ? 'on' : 'off'}`);
  console.log(`[mts] save:     ${args.save ? 'on' : 'off'}`);

  const client = axios.create({
    baseURL: baseUrl,
    timeout: TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    validateStatus: (s) => s >= 200 && s < 300,
  });

  // ISO local без TZ, чтобы не словить код 225 (несовместимый формат дат).
  const now = new Date();
  const dateTo = new Date(now.getTime()).toISOString().replace(/\.\d{3}Z$/, '');
  const dateFrom = new Date(now.getTime() - args.days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '');

  const results = {};

  // 1. Абоненты — критично; если упало, дальше нет смысла.
  results.subscribers = await fetchEndpoint(client, 'subscribers', 'get',
    '/subscriberManagement/subscribers',
    { params: { withCustomTemplateItems: true }, fatal: true },
  );

  const subscriberIDs = results.subscribers.items
    .map(s => Number(s.subscriberID))
    .filter(n => Number.isFinite(n));

  // 2. Группы — список + детали каждой.
  results.subscriberGroups = await fetchEndpoint(client, 'subscriberGroups', 'get',
    '/subscriberManagement/subscriberGroups',
  );

  if (results.subscriberGroups.ok) {
    const groupDetails = [];
    for (const g of results.subscriberGroups.items) {
      const gid = g.subscriberGroupID ?? g.id;
      if (gid == null) continue;
      const r = await fetchEndpoint(client, `subscriberGroup#${gid}`, 'get',
        `/subscriberManagement/subscriberGroups/${gid}`,
      );
      groupDetails.push(r.ok ? r.raw : { subscriberGroupID: gid, error: r.error });
    }
    results.subscriberGroupDetails = { count: groupDetails.length, items: groupDetails };
  }

  // 3. Последние локации.
  results.lastLocations = await fetchEndpoint(client, 'lastLocations', 'get',
    '/subscriberManagement/subscribers/lastLocations',
  );

  // 4. Детальный fetch по каждому абоненту (опционально).
  if (args.perSubscriber && subscriberIDs.length) {
    console.log(`[mts] per-subscriber: ${subscriberIDs.length} запросов…`);
    const details = [];
    for (const sid of subscriberIDs) {
      const r = await fetchEndpoint(client, `subscriber#${sid}`, 'get',
        `/subscriberManagement/subscribers/${sid}`,
        { params: { withCustomTemplateItems: true } },
      );
      details.push(r.ok ? r.raw : { subscriberID: sid, error: r.error });
    }
    results.subscriberDetails = { count: details.length, items: details };
  }

  // 5. Кастомные поля (определения шаблонов).
  results.customFields = await fetchEndpoint(client, 'customFields', 'get',
    '/customFieldsManagement/customFields',
  );

  // 6. LBS locations / tracks + GPS locations — за окно --days.
  if (args.locations && args.days > 0) {
    results.locations = await fetchPaged(client, 'locations',
      '/mobilePositioningManagement/locations',
      { dateFrom, dateTo },
      'lastLocationID', 'locationID', LBS_PAGE_SIZE,
    );
    results.tracks = await fetchPaged(client, 'tracks',
      '/mobilePositioningManagement/tracks',
      { dateFrom, dateTo },
      'lastTrackID', 'trackID', LBS_PAGE_SIZE,
    );
    results.globalLocations = await fetchPaged(client, 'globalLocations',
      '/globalPositioningManagement/locations',
      { dateFrom, dateTo },
      'lastLocationID', 'locationID', GPS_PAGE_SIZE,
    );
  }

  // === Консольная сводка ===
  console.log('\n=== Сводка ===');
  const summarize = (k, r) => {
    if (!r) { console.log(`${k.padEnd(22)}: skipped`); return; }
    if (r.ok === false) { console.log(`${k.padEnd(22)}: FAIL — ${fmtError(r.error)}`); return; }
    const cnt = r.count ?? r.totalCount ?? r.items?.length ?? 0;
    console.log(`${k.padEnd(22)}: ${cnt}`);
  };
  summarize('subscribers',          results.subscribers);
  summarize('subscriberGroups',     results.subscriberGroups);
  summarize('subscriberGroupDetail',results.subscriberGroupDetails);
  summarize('lastLocations',        results.lastLocations);
  summarize('subscriberDetails',    results.subscriberDetails);
  summarize('customFields',         results.customFields);
  summarize('locations',            results.locations);
  summarize('tracks',               results.tracks);
  summarize('globalLocations',      results.globalLocations);

  if (results.subscribers.items.length) {
    console.log('\n=== Абоненты (краткая таблица) ===');
    console.table(results.subscribers.items.map(r => ({
      subscriberID: r.subscriberID,
      name: r.name ?? null,
      phone: r.phone ?? null,
      isOnline: r.isOnline ?? null,
      canTrack: r.canTrack ?? null,
      isLocateEnabled: r.isLocateEnabled ?? null,
      lat: r.latitude ?? null,
      lon: r.longitude ?? null,
    })));
  }

  if (!args.save) {
    console.log('\n[mts] --no-save: файлы не пишутся.');
    return;
  }

  // === Запись в JSON ===
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = resolve(args.outDir || './data/mts');
  const outDir = join(outRoot, ts);
  await mkdir(outDir, { recursive: true });

  // Сохраняем сырые ответы (raw payload), без отсечения каких-либо полей.
  const writes = [];
  const writeJson = (name, value) => writes.push(
    writeFile(join(outDir, name), JSON.stringify(value, null, 2), 'utf8'),
  );

  writeJson('subscribers.json',          results.subscribers.raw);
  writeJson('subscriberGroups.json',     results.subscriberGroups.ok ? results.subscriberGroups.raw : { error: results.subscriberGroups.error });
  if (results.subscriberGroupDetails)
    writeJson('subscriberGroupDetails.json', results.subscriberGroupDetails);
  writeJson('lastLocations.json',        results.lastLocations.ok ? results.lastLocations.raw : { error: results.lastLocations.error });
  if (results.subscriberDetails)
    writeJson('subscriberDetails.json',  results.subscriberDetails);
  writeJson('customFields.json',         results.customFields.ok ? results.customFields.raw : { error: results.customFields.error });
  if (results.locations)
    writeJson('locations.json',          { dateFrom, dateTo, ...results.locations });
  if (results.tracks)
    writeJson('tracks.json',             { dateFrom, dateTo, ...results.tracks });
  if (results.globalLocations)
    writeJson('globalLocations.json',    { dateFrom, dateTo, ...results.globalLocations });

  const statusOf = (r) => {
    if (!r) return { status: 'skipped' };
    if (r.ok === false) return { status: 'error', error: r.error };
    return {
      status: 'ok',
      count: r.count ?? r.totalCount ?? r.items?.length ?? 0,
      durationMs: r.durationMs ?? null,
      pages: r.pages ?? null,
    };
  };

  writeJson('summary.json', {
    generatedAt: new Date().toISOString(),
    baseUrl,
    tokenPreview,
    options: {
      days: args.days,
      perSubscriber: args.perSubscriber,
      includeLocations: args.locations,
      dateFrom: args.locations ? dateFrom : null,
      dateTo: args.locations ? dateTo : null,
    },
    endpoints: {
      subscribers:             statusOf(results.subscribers),
      subscriberGroups:        statusOf(results.subscriberGroups),
      subscriberGroupDetails:  statusOf(results.subscriberGroupDetails),
      lastLocations:           statusOf(results.lastLocations),
      subscriberDetails:       statusOf(results.subscriberDetails),
      customFields:            statusOf(results.customFields),
      locations:               statusOf(results.locations),
      tracks:                  statusOf(results.tracks),
      globalLocations:         statusOf(results.globalLocations),
    },
  });

  await Promise.all(writes);
  console.log(`\n[mts] JSON выгружен в: ${outDir}`);
}

main().catch(err => {
  console.error('[mts] unhandled error:', err?.stack || err);
  process.exit(1);
});
