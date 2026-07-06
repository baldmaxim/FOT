/**
 * Проба: есть ли ФИО абонента в СИНХРОННОМ МТС API (READ-ONLY).
 *
 * Цель: PersonalDataInfo для корп-SIM пуст, имена есть только в XML (<tp u>).
 * Проверяем два кандидата, чьи ответы парсятся не полностью:
 *   [1] Bills/BillingStatementExtdByMSISDN — верхний уровень (мимо .Usages);
 *   [2] Service/HierarchyStructure — узел номера (мимо productSerialNumber/IMSI/SIM).
 * Печатает КЛЮЧИ (не значения) — по ним решаем, откуда тянуть ФИО автоматически.
 *
 * Запуск на проде (accountId резолвится по номеру, .env берётся из папки сайта):
 *   cd /opt/fot-build && npx tsx fot-server/scripts/probe-mts-business-subscriber.ts <msisdn>
 * Если .env в нестандартном месте: MTS_ENV_FILE=/путь/.env npx tsx ...
 *
 * Ничего не пишет в БД/МТС. Значения «именных» ключей маскируются (первая буква+***).
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env грузим ДО импорта app-модулей (env.ts валидирует при импорте).
const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[env] загружен ${envPath}`);
} else {
  console.warn('[env] .env не найден — переменные должны быть уже в окружении');
}

// Лёгкая маскировка ПДн в выводе: email и значения полей-имён.
// Маскируем значения любых «именных» ключей, чтобы дамп не светил ФИО целиком —
// достаточно видеть, ЧТО такой ключ есть (первая буква + ***).
const NAME_KEYS = new Set([
  'fio', 'name', 'organizationName', 'employeeFullName',
  'u', 'user', 'userName', 'label', 'alias', 'subscriberName', 'ownerName',
  'SurName', 'surName', 'FirstName', 'firstName', 'SecondName', 'secondName',
]);
const maskPii = (v: unknown, key?: string): unknown => {
  if (typeof v === 'string') {
    let s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
    if (key && NAME_KEYS.has(key) && s.length > 1) s = `${s[0]}***`;
    return s;
  }
  if (Array.isArray(v)) return v.map(x => maskPii(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = maskPii(val, k);
    return out;
  }
  return v;
};

// Фокус пробы: где в СИНХРОННОМ API спрятано имя абонента (ФИО).
// Проверяем два кандидата — верхний уровень BillingStatementExtd (мимо .Usages)
// и узел номера в HierarchyStructure. Вывод короткий, ПДн маскируется.
const main = async (): Promise<void> => {
  const [msisdn] = process.argv.slice(2);
  if (!msisdn) {
    console.error('Использование: probe-mts-business-subscriber.ts <msisdn>');
    process.exit(1);
  }

  const { mtsBusinessDataService } = await import('../src/services/mts-business-data.service.js');
  const { mtsBusinessCatalogService } = await import('../src/services/mts-business-catalog.service.js');
  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');
  const { normalizeMsisdn } = await import('../src/services/mts-business-cdr.service.js');

  const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
  if (!ctx) {
    console.error('Номер не привязан к аккаунту (нет account_id) — сначала прогони backfill.');
    process.exit(1);
  }
  const { accountId } = ctx;
  const norm = normalizeMsisdn(msisdn);
  console.log(`Проба ИМЁН: account=${accountId} msisdn=${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`);

  // 1) BillingStatementExtd — ключи верхнего уровня и всё, КРОМЕ Usages (там могло бы быть имя).
  try {
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    const fromD = new Date(today);
    fromD.setDate(fromD.getDate() - 30);
    const from = fromD.toISOString().slice(0, 10);
    const raw = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(accountId, { msisdn, dateFrom: from, dateTo: to });
    console.log('\n=== [1] BillingStatementExtd ===');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      console.log('ключи верхнего уровня:', JSON.stringify(Object.keys(r)));
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (k !== 'Usages' && k !== 'usages') rest[k] = v;
      console.log('верхний уровень без Usages (маск., 2500):', JSON.stringify(maskPii(rest)).slice(0, 2500));
    } else {
      console.log('тип ответа:', Array.isArray(raw) ? 'array' : typeof raw, JSON.stringify(maskPii(raw)).slice(0, 800));
    }
  } catch (e) {
    console.log('[1] BillingStatementExtd ОШИБКА:', e instanceof Error ? e.message : String(e));
  }

  // 2) HierarchyStructure — сколько узлов номера, ключи узла нашего номера, образец.
  try {
    const rawH = await mtsBusinessCatalogService.getHierarchyStructureRaw(accountId);
    const nodes: Record<string, unknown>[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        if ('productSerialNumber' in r) nodes.push(r);
        Object.values(r).forEach(walk);
      }
    };
    walk(rawH);
    const node = nodes.find(n => normalizeMsisdn(String(n.productSerialNumber)) === norm) ?? nodes[0];
    const matched = node ? normalizeMsisdn(String(node.productSerialNumber)) === norm : false;
    console.log('\n=== [2] HierarchyStructure ===');
    console.log('узлов с productSerialNumber:', nodes.length, '| наш номер найден:', matched);
    console.log('ключи узла номера:', node ? JSON.stringify(Object.keys(node)) : 'узел не найден');
    if (node) console.log('узел (маск., 2500):', JSON.stringify(maskPii(node)).slice(0, 2500));
  } catch (e) {
    console.log('[2] HierarchyStructure ОШИБКА:', e instanceof Error ? e.message : String(e));
  }

  process.exit(0);
};

void main().catch(err => {
  console.error('Проба упала:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
