/**
 * Точечная диагностика коллизии W26 по пропуску 637 (READ-ONLY, ничего не пишет).
 *
 * Кейс: пропуск 637, карта UID `1826CCC200000000` (W26 38,52418 / value 26CCC2),
 * держатель Агаев Роман. Согласование упало: «карта 4698 уже привязана в Sigur к
 * employeeId 122702 (Махкамов Акрамжон)». Скрипт проверяет, активна ли эта привязка
 * у Махкамова или она устаревшая (дубль) — от этого зависит ремедиация.
 *
 * Запуск (локально, БД и Sigur — прод):
 *   cd fot-server && npx tsx scripts/diagnose-pass-637-card-collision.ts
 *
 * Кандидаты карты и id можно переопределить через env:
 *   CARD_CANDIDATES="26CCC2,38,52418,1826CCC200000000"  (через запятую)
 *   OWNER_EMPLOYEE_ID=122702   POOL_EMPLOYEE_ID=144232   PASS_NUMBER=637
 *
 * Подключение к прод-БД локально — по приёму из [[reference_prod_db_local_diagnostics]]:
 * чистим ssl-параметры из DATABASE_URL и передаём локальный CA, NODE_ENV=test чтобы
 * dotenv не перетёр override'ом.
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
  console.log('=== Диагностика коллизии W26 по пропуску 637 (read-only) ===\n');

  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { deriveCardW26 } = await import('../src/services/sigur-card-w26.util.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');

  const PASS_NUMBER = (process.env.PASS_NUMBER ?? '637').trim();
  const OWNER_EMPLOYEE_ID = Number(process.env.OWNER_EMPLOYEE_ID ?? '122702');
  const POOL_EMPLOYEE_ID = Number(process.env.POOL_EMPLOYEE_ID ?? '144232');

  const normInt = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.trim()); if (Number.isFinite(n)) return n; }
    return null;
  };
  const cardIdOf = (raw: Record<string, unknown>): number | null =>
    normInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));
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

  // 0) Строка пропуска в БД (для контекста).
  const dbRow = await query<{
    id: string; pass_number: string; card_uid: string | null; holder_name: string | null;
    sigur_employee_id: number | null; status: string; approval_status: string;
  }>(
    `SELECT id, pass_number, card_uid, holder_name, sigur_employee_id, status, approval_status
       FROM contractor_passes WHERE pass_number = $1 ORDER BY created_at LIMIT 1`,
    [PASS_NUMBER],
  );
  console.log('--- Пропуск в БД ---');
  for (const r of dbRow) {
    let w26 = '?';
    try { w26 = deriveCardW26(r.card_uid ?? '').w26; } catch { /* noop */ }
    console.log(`  №${r.pass_number} | ${r.holder_name ?? '—'} | uid=${r.card_uid} | W26=${w26} | poolSigurId=${r.sigur_employee_id} | ${r.status}/${r.approval_status}`);
  }
  console.log('');

  const connection = await sigurService.getBackgroundConnectionType();
  const deptMap = await sigurService.getDepartmentMapCached(connection).catch(() => new Map<number, string>());

  const describeEmployee = async (id: number, label: string): Promise<void> => {
    try {
      const raw = await sigurService.getEmployeeById(id, connection) as Record<string, unknown>;
      const name = String(resolveField(raw, 'name', 'fullName', 'FullName', 'Name') ?? '').trim() || '?';
      const deptId = normInt(resolveField(raw, 'departmentId', 'department_id', 'depId'));
      const blockedRaw = resolveField(raw, 'blocked', 'Blocked', 'isBlocked');
      const dismissedRaw = resolveField(raw, 'dismissed', 'fired', 'isDismissed', 'dismissDate', 'dismissalDate');
      console.log(`  ${label}: id=${id} «${name}» / отдел ${deptId != null ? (deptMap.get(deptId) ?? `#${deptId}`) : '—'}`
        + ` | blocked=${blockedRaw ?? '—'} | dismissed=${dismissedRaw ?? '—'}`);
    } catch (e) {
      console.log(`  ${label}: id=${id} — профиль не получен (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  // Кандидаты для поиска карты.
  const CAND = (process.env.CARD_CANDIDATES ?? '26CCC2,38,52418,1826CCC200000000')
    .split(',').map(s => s.trim()).filter(Boolean);
  // '38,52418' в env склеивается через запятую — восстановим W26-форму дополнительно.
  const candidates = [...new Set([...CAND, '38,52418'])];
  console.log(`--- Поиск карты в Sigur по кандидатам: ${candidates.join(' | ')} ---`);

  const { matches, tried } = await sigurService.findCardByCandidates(candidates, connection);
  const cards = matches as Record<string, unknown>[];
  console.log(`  tried keys: ${tried.join(', ')}`);
  console.log(`  найдено карт: ${cards.length}`);
  const cardIds = [...new Set(cards.map(cardIdOf).filter((x): x is number => !!x))];
  for (const c of cards) {
    console.log(`  card: id=${cardIdOf(c)} | value=${resolveField(c, 'value', 'cardValue', 'card_value') ?? '—'}`
      + ` | format=${resolveField(c, 'format', 'Format', 'cardFormat') ?? '—'}`
      + ` | number=${resolveField(c, 'number', 'cardNumber', 'card_number') ?? '—'}`);
  }
  console.log('');

  // 2) Привязки по каждому cardId + даты действия.
  console.log('--- Привязки карты (getCardBindings by cardId) ---');
  const ownersByCard = new Set<number>();
  for (const cid of cardIds) {
    const binds = await sigurService.getCardBindings({ cardId: cid }, connection) as Record<string, unknown>[];
    if (binds.length === 0) { console.log(`  card ${cid}: привязок нет`); continue; }
    for (const b of binds) {
      const owner = bindingOwnerOf(b);
      if (owner) ownersByCard.add(owner);
      const start = resolveField(b, 'startDate', 'start_date', 'from', 'validFrom');
      const end = resolveField(b, 'expirationDate', 'expiration_date', 'endDate', 'to', 'validTo');
      console.log(`  card ${cid}: employeeId=${owner ?? '—'} | start=${start ?? '—'} | end=${end ?? '—'}`);
    }
  }
  console.log('');

  // 3) Все карты владельца-«захватчика» (Махкамов) — есть ли у него другая карта.
  console.log(`--- Все карты владельца employeeId=${OWNER_EMPLOYEE_ID} (getCardBindings by employeeId) ---`);
  try {
    const ownerBinds = await sigurService.getCardBindings({ employeeId: OWNER_EMPLOYEE_ID }, connection) as Record<string, unknown>[];
    if (ownerBinds.length === 0) console.log('  привязок нет (возможно, фильтр по employeeId не поддержан — см. вывод by cardId выше)');
    for (const b of ownerBinds) {
      const cid = cardIdOf(b) ?? normInt(resolveField(b, 'cardId', 'card_id'));
      const start = resolveField(b, 'startDate', 'start_date', 'from', 'validFrom');
      const end = resolveField(b, 'expirationDate', 'expiration_date', 'endDate', 'to', 'validTo');
      console.log(`  cardId=${cid ?? '—'} | start=${start ?? '—'} | end=${end ?? '—'}`);
    }
  } catch (e) {
    console.log(`  ошибка: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log('');

  // 4) Профили: захватчик + пул-профиль 637.
  console.log('--- Профили Sigur ---');
  await describeEmployee(OWNER_EMPLOYEE_ID, 'Владелец карты 4698');
  await describeEmployee(POOL_EMPLOYEE_ID, 'Пул-профиль 637');

  console.log('\n--- Вывод ---');
  console.log(`  Владельцы карты по value: ${[...ownersByCard].join(', ') || '—'}`);
  if (ownersByCard.has(OWNER_EMPLOYEE_ID)) {
    console.log('  → Карта действительно за Махкамовым. Смотри даты binding и его вторую карту выше:');
    console.log('    • если binding истёк / у него есть другая рабочая карта → 4698 можно освободить и привязать к 637;');
    console.log('    • если binding активен и это единственная карта → реальная коллизия W26, нужна замена карты Агаеву.');
  }

  console.log('\n=== готово (read-only, ничего не записано) ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
