/**
 * Точечная диагностика пропуска 1651 (READ-ONLY, ничего не пишет в Sigur/БД).
 *
 * Кейс: пропуск 1651, СТРОЙРЕСУРС ООО, держатель «Джумаев Анвар Холмуминович»,
 * карта UID `1823780300000000` (value 237803 = W26 35,30723), точка «Примавера 71/14-КПП».
 * В БД FOT: status=applied, approval=approved, sigur_employee_id=145244, sync=synced, ошибок нет.
 * Но физически пропуск не выдаётся. Скрипт различает ТРИ исхода на стороне Sigur:
 *   (A) карты со значением 237803 в Sigur нет вовсе;
 *   (B) карта есть, но не привязана ни к кому;
 *   (C) карта привязана к ДРУГОМУ employeeId (W26-коллизия / чужой пластик);
 *   (D) карта на 145244 — тогда проблема в профиле (blocked/отдел) или в точках/правилах доступа.
 *
 * Только GET-вызовы Sigur (findCardByCandidates, getCardBindings, getEmployeeById,
 * getEmployeeAccessPoint/RuleBindings). Никаких мутаций.
 *
 * Запуск (локально, БД и Sigur — прод):
 *   cd fot-server && npx tsx scripts/diagnose-pass-1651-card-collision.ts
 *
 * Переопределение через env:
 *   PASS_NUMBER=1651  POOL_EMPLOYEE_ID=145244
 *   CARD_CANDIDATES="1823780300000000,35,30723,237803"  (через запятую)
 *
 * Подключение к прод-БД локально — по приёму из [[reference_prod_db_local_diagnostics]].
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL не найден в fot-server/.env');
    process.exit(1);
  }
  try {
    const u = new URL(rawUrl);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
  const dbg = new URL(process.env.DATABASE_URL);
  console.error('[debug] db host:', dbg.hostname, 'db:', dbg.pathname);
}

async function main() {
  console.log('=== Диагностика пропуска 1651 (read-only, ничего не пишем) ===\n');

  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { deriveCardW26 } = await import('../src/services/sigur-card-w26.util.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');

  const PASS_NUMBER = (process.env.PASS_NUMBER ?? '1651').trim();
  const POOL_EMPLOYEE_ID = Number(process.env.POOL_EMPLOYEE_ID ?? '145244');

  const normInt = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.trim()); if (Number.isFinite(n)) return n; }
    return null;
  };
  const cardIdOf = (raw: Record<string, unknown>): number | null =>
    normInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));
  const cardValueOf = (raw: Record<string, unknown>): string =>
    String(resolveField(raw, 'value', 'cardValue', 'card_value') ?? '').trim();
  const bindingOwnerOf = (raw: Record<string, unknown>): number | null => {
    const direct = normInt(resolveField(raw, 'employeeId', 'employee_id'));
    if (direct) return direct;
    const holder = raw.holder as Record<string, unknown> | undefined;
    if (holder && typeof holder === 'object') {
      const t = typeof holder.type === 'string' ? holder.type.toUpperCase() : '';
      if (!t || t === 'EMP' || t === 'EMPLOYEE') return normInt(resolveField(holder, 'holderId', 'holder_id', 'id'));
    }
    return null;
  };

  // Логика isExactCardMatch (не экспортирована из sigur-live-cards.service) — воспроизводим:
  // ?value= у Sigur делает ПРЕФИКСНЫЙ матч, поэтому сверяем полный 3-байтовый value или W26.
  const normVal = (s: string): string => s.toUpperCase().replace(/^0+/, '');
  const normW26 = (s: string): string => {
    const m = s.replace(/\s/g, '').match(/^(\d+),(\d+)$/);
    return m ? `${Number(m[1])},${Number(m[2])}` : '';
  };
  const isExactMatch = (raw: Record<string, unknown>, decoded: ReturnType<typeof deriveCardW26>): boolean => {
    const value = normVal(cardValueOf(raw));
    if (value && value === normVal(decoded.value)) return true;
    const fmt = normW26(String(resolveField(raw, 'formattedValue', 'formatted_value') ?? ''));
    return !!fmt && fmt === normW26(decoded.w26);
  };

  // 0) Строка пропуска в БД (контекст).
  const dbRow = await query<{
    id: string; pass_number: string; card_uid: string | null; card_hex_uid: string | null;
    holder_name: string | null; sigur_employee_id: number | null; status: string; approval_status: string;
    is_active: boolean; access_point_names: string[] | null;
  }>(
    `SELECT id, pass_number, card_uid, card_hex_uid, holder_name, sigur_employee_id,
            status, approval_status, is_active, access_point_names
       FROM contractor_passes WHERE pass_number = $1 ORDER BY created_at LIMIT 1`,
    [PASS_NUMBER],
  );
  console.log('--- 1. Пропуск в БД FOT ---');
  let dbCardUid = '';
  for (const r of dbRow) {
    dbCardUid = r.card_uid ?? '';
    let w26 = '?';
    try { w26 = deriveCardW26(r.card_uid ?? '').w26; } catch { /* noop */ }
    console.log(`  №${r.pass_number} | ${r.holder_name ?? '—'} | uid=${r.card_uid} | hex=${r.card_hex_uid ?? '—'} | W26=${w26}`);
    console.log(`  poolSigurId=${r.sigur_employee_id} | ${r.status}/${r.approval_status} | active=${r.is_active} | points=${(r.access_point_names ?? []).join(', ') || '—'}`);
  }
  if (!dbCardUid) { console.log('  ПРОПУСК НЕ НАЙДЕН в БД — прекращаю.'); return; }
  const decoded = deriveCardW26(dbCardUid);
  console.log(`  decoded target: value=${decoded.value} | W26=${decoded.w26}`);
  console.log('');

  const connection = await sigurService.getBackgroundConnectionType();
  const deptMap = await sigurService.getDepartmentMapCached(connection).catch(() => new Map<number, string>());
  const apMap = await sigurService.getAccessPointMapCached(connection).catch(() => new Map<number, string>());
  const ruleMap = await sigurService.getAccessRuleMapCached(connection).catch(() => new Map<number, string>());

  const describeEmployee = async (id: number, label: string): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await sigurService.getEmployeeById(id, connection) as Record<string, unknown>;
      const name = String(resolveField(raw, 'name', 'fullName', 'FullName', 'Name') ?? '').trim() || '?';
      const deptId = normInt(resolveField(raw, 'departmentId', 'department_id', 'depId'));
      const blockedRaw = resolveField(raw, 'blocked', 'Blocked', 'isBlocked');
      const dismissedRaw = resolveField(raw, 'dismissed', 'fired', 'isDismissed', 'dismissDate', 'dismissalDate');
      console.log(`  ${label}: id=${id} «${name}» / отдел ${deptId != null ? (deptMap.get(deptId) ?? `#${deptId}`) : '—'}`
        + ` | blocked=${blockedRaw ?? '—'} | dismissed=${dismissedRaw ?? '—'}`);
      return raw;
    } catch (e) {
      console.log(`  ${label}: id=${id} — профиль НЕ получен (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  };

  // 2) Поиск карты в Sigur по кандидатам.
  const CAND = (process.env.CARD_CANDIDATES ?? `${dbCardUid},${decoded.w26},${decoded.value}`)
    .split(',').map(s => s.trim()).filter(Boolean);
  const candidates = [...new Set([...CAND, decoded.w26, decoded.value, dbCardUid])];
  console.log(`--- 2. Поиск карты в Sigur (findCardByCandidates) ---`);
  console.log(`  кандидаты: ${candidates.join(' | ')}`);
  const { matches, tried } = await sigurService.findCardByCandidates(candidates, connection);
  const cards = matches as Record<string, unknown>[];
  console.log(`  tried keys: ${tried.join(', ')}`);
  console.log(`  найдено (сырой префиксный матч): ${cards.length}`);
  for (const c of cards) {
    console.log(`    card: id=${cardIdOf(c)} | value=${cardValueOf(c) || '—'}`
      + ` | formatted=${resolveField(c, 'formattedValue', 'formatted_value') ?? '—'}`
      + ` | format=${resolveField(c, 'format', 'Format', 'cardFormat') ?? '—'}`);
  }
  console.log('');

  // 3) Точное совпадение (exact match) — только настоящие карты 237803 / W26 35,30723.
  console.log('--- 3. Точное совпадение карты (isExactCardMatch) ---');
  const exact = cards.filter(c => isExactMatch(c, decoded));
  console.log(`  точных совпадений: ${exact.length}`);
  const exactCardIds = [...new Set(exact.map(cardIdOf).filter((x): x is number => !!x))];
  for (const c of exact) {
    console.log(`    EXACT card: id=${cardIdOf(c)} | value=${cardValueOf(c)} | formatted=${resolveField(c, 'formattedValue', 'formatted_value') ?? '—'}`);
  }
  console.log('');

  // 4) Привязки по каждому cardId (кто владелец карты в Sigur).
  console.log('--- 4. Привязки карты в Sigur (getCardBindings by cardId) ---');
  const ownersByCard = new Set<number>();
  for (const cid of exactCardIds) {
    const binds = await sigurService.getCardBindings({ cardId: cid }, connection) as Record<string, unknown>[];
    if (binds.length === 0) { console.log(`  card ${cid}: привязок НЕТ (карта свободна)`); continue; }
    for (const b of binds) {
      const owner = bindingOwnerOf(b);
      if (owner) ownersByCard.add(owner);
      const start = resolveField(b, 'startDate', 'start_date', 'from', 'validFrom');
      const end = resolveField(b, 'expirationDate', 'expiration_date', 'endDate', 'to', 'validTo');
      console.log(`  card ${cid}: employeeId=${owner ?? '—'} | start=${start ?? '—'} | end=${end ?? '—'}`);
    }
  }
  console.log('');

  // 5) Привязки карт по нашему профилю 145244 (что реально на нём висит).
  console.log(`--- 5. Карты профиля employeeId=${POOL_EMPLOYEE_ID} (getCardBindings by employeeId) ---`);
  try {
    const binds = await sigurService.getCardBindings({ employeeId: POOL_EMPLOYEE_ID }, connection) as Record<string, unknown>[];
    if (binds.length === 0) console.log('  привязок нет');
    for (const b of binds) {
      const cid = cardIdOf(b) ?? normInt(resolveField(b, 'cardId', 'card_id'));
      const start = resolveField(b, 'startDate', 'start_date', 'from', 'validFrom');
      const end = resolveField(b, 'expirationDate', 'expiration_date', 'endDate', 'to', 'validTo');
      console.log(`  cardId=${cid ?? '—'} | start=${start ?? '—'} | end=${end ?? '—'}`);
    }
  } catch (e) {
    console.log(`  ошибка: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log('');

  // 6) Профиль 145244 + владельцы-«захватчики» карты.
  console.log('--- 6. Профили Sigur ---');
  await describeEmployee(POOL_EMPLOYEE_ID, 'Наш профиль 1651');
  for (const ownerId of ownersByCard) {
    if (ownerId !== POOL_EMPLOYEE_ID) await describeEmployee(ownerId, `Владелец карты (ЧУЖОЙ)`);
  }
  console.log('');

  // 7) Точки и правила доступа профиля 145244.
  console.log(`--- 7. Точки/правила доступа профиля ${POOL_EMPLOYEE_ID} ---`);
  const apBinds = await sigurService.getEmployeeAccessPointBindings({ employeeId: POOL_EMPLOYEE_ID }, connection);
  console.log(`  точки доступа: ${apBinds.length}`);
  for (const b of apBinds) {
    const apId = normInt(resolveField(b, 'accessPointId', 'access_point_id', 'apId', 'id'));
    console.log(`    • ${apId != null ? (apMap.get(apId) ?? `#${apId}`) : '—'}`);
  }
  const ruleBinds = await sigurService.getEmployeeAccessRuleBindings({ employeeId: POOL_EMPLOYEE_ID }, connection);
  console.log(`  правила доступа: ${ruleBinds.length}`);
  for (const b of ruleBinds) {
    const rId = normInt(resolveField(b, 'accessRuleId', 'access_rule_id', 'ruleId', 'id'));
    console.log(`    • ${rId != null ? (ruleMap.get(rId) ?? `#${rId}`) : '—'}`);
  }
  console.log('');

  // 8) Вердикт (трёхисходная развилка).
  console.log('=== ВЫВОД ===');
  const otherOwners = [...ownersByCard].filter(id => id !== POOL_EMPLOYEE_ID);
  if (exact.length === 0) {
    console.log('  (A) Карты со значением ' + decoded.value + ' (W26 ' + decoded.w26 + ') в Sigur НЕТ.');
    console.log('      → пропуск не выдан, потому что карта не заведена. Ремедиация: создать карту и привязать к ' + POOL_EMPLOYEE_ID + '.');
  } else if (otherOwners.length > 0) {
    console.log('  (C) Карта привязана к ЧУЖОМУ профилю: employeeId ' + otherOwners.join(', ') + ' (см. ФИО/отдел выше).');
    console.log('      → W26-коллизия / карта записана на другого. НИЧЕГО НЕ ОТВЯЗЫВАЕМ автоматически (safe-only).');
    console.log('      Ремедиация — операционная: сверить ФИО, при необходимости заменить пластик или освободить старую привязку вручную.');
  } else if (ownersByCard.size === 0) {
    console.log('  (B) Карта в Sigur ЕСТЬ, но НЕ привязана ни к кому (card ' + exactCardIds.join(', ') + ').');
    console.log('      → пропуск не работает из-за отсутствия привязки. Ремедиация: привязать карту к ' + POOL_EMPLOYEE_ID + '.');
  } else {
    console.log('  (D) Карта корректно на нашем профиле ' + POOL_EMPLOYEE_ID + '. Коллизии нет.');
    console.log('      → причина в профиле/доступах: проверь blocked, отдел (должен быть 143539 СТРОЙРЕСУРС),');
    console.log('        и наличие точки «Примавера 71/14-КПП» в списке точек/правил выше.');
  }
  console.log('\n=== готово (read-only, ничего не записано) ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
