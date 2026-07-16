/**
 * Проба: ГДЕ в МТС Business API лежит статус блокировки SIM (READ-ONLY).
 *
 * Задача: у нас нет надёжного признака «SIM заблокирован». Метрика
 * connected_blocks — на деле полный список услуг (все status=ACTIVE), а из
 * блокировочных продуктов встречается лишь маркер PE2125 «Скидка 14 дней на
 * добровольную блокировку». Нужно найти поле, отличающее blocked↔active.
 *
 * Что делает:
 *   1) Автоподбор seed-номеров (точного эталона нет — берём косвенные):
 *        BLOCKED-LIKELY = номера с продуктом PE2125 + номера с «блокиров» в
 *        mts_comment; ACTIVE = номера с недавним трафиком (mts_business_cdr).
 *      Плейнтекст номеров берём из снапшота hierarchy (там msisdn открытым),
 *      сопоставляя по sha256(normalizeMsisdn).
 *   2) Для каждого seed дампит (маскируя ПДн):
 *        [A] узел номера из Service/HierarchyStructure целиком — ГИПОТЕЗА №1
 *            (ищем ключ status/state/blockStatus и т.п.);
 *        [B] коды+status продуктов getConnectedBlocks / getProductInfo — вдруг у
 *            заблокированных есть отдельный продукт или не-ACTIVE статус.
 *   3) Печатает сводку: какие product-коды и какие значения status-полей
 *      встречаются ТОЛЬКО в группе blocked-likely.
 *
 * Запуск на проде (.env берётся из папки сайта):
 *   cd /opt/fot-build && npx tsx fot-server/scripts/mts-probe-sim-status.ts
 *   # опционально свои номера: ... mts-probe-sim-status.ts 79xxxxxxxxx 79yyyyyyyyy
 *
 * Ничего не пишет в БД/МТС.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Маскировка ПДн в дампе: email + «именные» ключи (первая буква + ***).
const NAME_KEYS = new Set([
  'fio', 'name', 'organizationName', 'employeeFullName', 'u', 'user', 'userName',
  'label', 'alias', 'subscriberName', 'ownerName', 'SurName', 'surName',
  'FirstName', 'firstName', 'SecondName', 'secondName',
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

const short = (m: string): string => `${m.slice(0, 4)}***${m.slice(-2)}`;
// Ключи, «похожие на статус», — подсвечиваем в узле для быстрого глаза.
const STATUSISH = /(status|state|block|suspend|active|lifecycle|заблок|приостан|блокир|состоя)/i;
const findStatusKeys = (o: unknown, prefix = ''): string[] => {
  const hits: string[] = [];
  const walk = (node: unknown, pre: string): void => {
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${pre}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
        const p = pre ? `${pre}.${k}` : k;
        if (STATUSISH.test(k) && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
          hits.push(`${p} = ${String(val)}`);
        }
        walk(val, p);
      }
    }
  };
  walk(o, prefix);
  return hits;
};

interface ISeed { msisdn: string; accountNo: string | null; group: 'blocked?' | 'active'; reason: string }

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { mtsBusinessCatalogService } = await import('../src/services/mts-business-catalog.service.js');
  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');
  const { normalizeMsisdn, msisdnHash } = await import('../src/services/mts-business-cdr.service.js');

  // --- Плейнтекст-карта номеров из свежего снапшота hierarchy (msisdn открытым) ---
  const hierRows = await query<{ payload: { numbers?: { msisdn: string; accountNo: string | null }[] } }>(
    `SELECT payload FROM mts_business_metric_snapshot
      WHERE metric = 'hierarchy' AND scope = 'account'
      ORDER BY captured_date DESC LIMIT 20`,
  );
  const hashToPlain = new Map<string, { msisdn: string; accountNo: string | null }>();
  for (const r of hierRows) {
    for (const n of r.payload?.numbers ?? []) {
      const h = msisdnHash(n.msisdn);
      if (h && !hashToPlain.has(h)) hashToPlain.set(h, { msisdn: normalizeMsisdn(n.msisdn) as string, accountNo: n.accountNo ?? null });
    }
  }
  console.log(`[seed] плейнтекст-карта из hierarchy: ${hashToPlain.size} номеров`);

  const seeds: ISeed[] = [];
  const argMsisdns = process.argv.slice(2).map(m => normalizeMsisdn(m)).filter((m): m is string => Boolean(m));

  if (argMsisdns.length) {
    for (const m of argMsisdns) seeds.push({ msisdn: m, accountNo: hashToPlain.get(msisdnHash(m) as string)?.accountNo ?? null, group: 'blocked?', reason: 'argv' });
  } else {
    // BLOCKED-LIKELY №1: продукт PE2125 в свежем connected_blocks.
    const pe2125 = await query<{ msisdn_hash: string }>(
      `SELECT DISTINCT ON (msisdn_hash) msisdn_hash FROM mts_business_metric_snapshot
        WHERE metric = 'connected_blocks' AND payload @> '[{"code":"PE2125"}]'
        ORDER BY msisdn_hash, captured_date DESC LIMIT 8`,
    );
    for (const r of pe2125) {
      const p = hashToPlain.get(r.msisdn_hash);
      if (p) seeds.push({ msisdn: p.msisdn, accountNo: p.accountNo, group: 'blocked?', reason: 'PE2125' });
    }
    // BLOCKED-LIKELY №2: «блокиров» в комментарии.
    const byComment = await query<{ msisdn_hash: string }>(
      `SELECT msisdn_hash FROM mts_business_number_map
        WHERE mts_comment ILIKE '%блокиров%' AND msisdn_hash IS NOT NULL LIMIT 8`,
    );
    for (const r of byComment) {
      const p = hashToPlain.get(r.msisdn_hash);
      if (p && !seeds.some(s => s.msisdn === p.msisdn)) seeds.push({ msisdn: p.msisdn, accountNo: p.accountNo, group: 'blocked?', reason: 'comment:блокиров' });
    }
    // ACTIVE: недавний трафик из CDR.
    const active = await query<{ msisdn_hash: string }>(
      `SELECT msisdn_hash, MAX(started_at) mx FROM mts_business_cdr
        WHERE msisdn_hash IS NOT NULL AND started_at > now() - interval '4 days'
        GROUP BY msisdn_hash ORDER BY mx DESC LIMIT 6`,
    );
    for (const r of active) {
      const p = hashToPlain.get(r.msisdn_hash);
      if (p && !seeds.some(s => s.msisdn === p.msisdn)) seeds.push({ msisdn: p.msisdn, accountNo: p.accountNo, group: 'active', reason: 'recent CDR' });
    }
  }

  if (!seeds.length) {
    console.error('Не удалось подобрать seed-номера. Проверь снапшот hierarchy / передай номера аргументами.');
    process.exit(1);
  }
  console.log(`[seed] отобрано ${seeds.length}: ` + seeds.map(s => `${short(s.msisdn)}(${s.group}/${s.reason})`).join(', '));

  // --- Кэш raw-иерархии по аккаунту (1 запрос на ЛС) ---
  const hierCache = new Map<string, unknown>();
  const getHier = async (accountId: string): Promise<unknown> => {
    if (!hierCache.has(accountId)) hierCache.set(accountId, await mtsBusinessCatalogService.getHierarchyStructureRaw(accountId));
    return hierCache.get(accountId);
  };
  const nodesOf = (rawH: unknown): Record<string, unknown>[] => {
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
    return nodes;
  };

  // Собираем для сводки: коды продуктов и status-поля по группам.
  const codesByGroup: Record<string, Set<string>> = { 'blocked?': new Set(), active: new Set() };
  const statusesByGroup: Record<string, Set<string>> = { 'blocked?': new Set(), active: new Set() };

  for (const s of seeds) {
    console.log(`\n================ ${short(s.msisdn)} [${s.group} / ${s.reason}] ================`);
    const ctx = await mtsBusinessMappingService.getSubscriberContext(s.msisdn);
    if (!ctx?.accountId) { console.log('  нет account_id — пропуск'); continue; }
    const accountId = ctx.accountId;
    const norm = normalizeMsisdn(s.msisdn) as string;

    // [A] узел иерархии
    try {
      const node = nodesOf(await getHier(accountId)).find(n => normalizeMsisdn(String(n.productSerialNumber)) === norm);
      console.log('--- [A] HierarchyStructure node ---');
      if (node) {
        const stKeys = findStatusKeys(node);
        console.log('  ключи узла:', JSON.stringify(Object.keys(node)));
        console.log('  status-подобные:', stKeys.length ? stKeys.join(' | ') : '— нет —');
        console.log('  узел (маск., 2000):', JSON.stringify(maskPii(node)).slice(0, 2000));
        for (const kv of stKeys) statusesByGroup[s.group].add(`A:${kv.split(' = ')[0]}=${kv.split(' = ')[1]}`);
      } else {
        console.log('  узел номера не найден в иерархии');
      }
    } catch (e) { console.log('  [A] ОШИБКА:', e instanceof Error ? e.message : String(e)); }

    // [B] продукты: коды + status
    try {
      const [blocks, services] = await Promise.all([
        mtsBusinessCatalogService.getConnectedBlocks(accountId, norm).catch(() => []),
        mtsBusinessCatalogService.getProductInfo(accountId, norm).catch(() => []),
      ]);
      const all = [...blocks, ...services] as { code?: string | null; name?: string | null; status?: string | null }[];
      const nonActive = all.filter(p => (p.status ?? '').toUpperCase() !== 'ACTIVE');
      console.log('--- [B] продукты ---');
      console.log(`  всего=${all.length}, не-ACTIVE=${nonActive.length}`);
      if (nonActive.length) console.log('  не-ACTIVE:', nonActive.map(p => `${p.code}:${p.name}=${p.status}`).join(' | '));
      for (const p of all) {
        if (p.code) codesByGroup[s.group].add(p.code);
        if (p.status) statusesByGroup[s.group].add(`B:${p.status}`);
      }
    } catch (e) { console.log('  [B] ОШИБКА:', e instanceof Error ? e.message : String(e)); }
  }

  // --- Сводка: что есть ТОЛЬКО у blocked-likely ---
  const onlyBlockedCodes = [...codesByGroup['blocked?']].filter(c => !codesByGroup.active.has(c));
  const onlyBlockedStatuses = [...statusesByGroup['blocked?']].filter(c => !statusesByGroup.active.has(c));
  console.log('\n================ СВОДКА ================');
  console.log('product-коды ТОЛЬКО у blocked-likely:', onlyBlockedCodes.length ? onlyBlockedCodes.join(', ') : '— нет —');
  console.log('status-значения ТОЛЬКО у blocked-likely:', onlyBlockedStatuses.length ? onlyBlockedStatuses.join(', ') : '— нет —');
  console.log('\nВывод для интеграции: если в [A] есть status-подобный ключ, различающий группы —');
  console.log('парсим его в parseHierarchy. Иначе смотрим product-коды/статусы из [B].');
  console.log('Если оба пусты — нужен раунд 2: raw CheckBalanceByMSISDN / ValidityInfo / subscriberManagement.');

  process.exit(0);
};

void main().catch(err => {
  console.error('Проба упала:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
