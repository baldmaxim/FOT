/**
 * Ремедиация подрядных пропусков «Нет пропуска» в Sigur.
 *
 * Чинит уже активированные пропуска (is_active=true / status='applied'), у которых в
 * Sigur нет карты: вычисляет W26 из card_uid, при отсутствии карты создаёт её
 * (POST /cards, format W26) и привязывает к профилю. БД НЕ меняет — пишет только в Sigur.
 *
 * По умолчанию — СУХОЙ ПРОГОН (ничего не пишет, печатает таблицу действий).
 * Боевой режим — только с флагом --apply.
 *
 * Запуск (локально, БД и Sigur — прод):
 *   cd fot-server && npx tsx scripts/remediate-contractor-no-card.ts                 # dry-run
 *   cd fot-server && npx tsx scripts/remediate-contractor-no-card.ts --name "Дакенов"  # один пропуск, dry-run
 *   cd fot-server && npx tsx scripts/remediate-contractor-no-card.ts --name "Дакенов" --apply  # боевой
 *
 * Флаги:
 *   --apply                  боевой режим (создание карт + привязка в Sigur)
 *   --name <substr>          фильтр по ФИО держателя (подстрока, регистронезависимо)
 *   --pass <number>          фильтр по номеру пропуска
 *   --allow-count-mismatch   снять защиту «слишком много строк» (>100)
 *
 * Подключение к прод-БД — по приёму из [[reference_prod_db_local_diagnostics]]:
 * чистим ssl-параметры из DATABASE_URL и передаём локальный CA, NODE_ENV=test.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(name);
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const APPLY = hasFlag('--apply');
const FILTER_NAME = flagValue('--name');
const FILTER_PASS = flagValue('--pass');
const ALLOW_COUNT_MISMATCH = hasFlag('--allow-count-mismatch');
const MAX_SAFE_COUNT = 100; // защита от случайного захвата пула (~1927)

// 1) Готовим env ДО импорта app-модулей (last-wins из .env, см. диагностический скрипт).
process.env.NODE_ENV = 'test';

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
process.env.DATABASE_SSL_CA_PATH = path.resolve(__dirname, '../../.migration/yandex-ca.pem');

interface IPassRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  sigur_employee_id: number | null;
  card_uid: string | null;
  status: string;
  is_active: boolean;
}

async function main() {
  console.log(`=== Ремедиация подрядных карт (${APPLY ? 'БОЕВОЙ --apply' : 'СУХОЙ ПРОГОН'}) ===\n`);

  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { getSigurEmployeeCardStatuses } = await import('../src/services/sigur-live-admin.service.js');
  const { deriveCardW26, assignSigurEmployeeCardBinding } = await import('../src/services/sigur-live-cards.service.js');

  const connection = await sigurService.getBackgroundConnectionType();

  // 1) Активированные пропуска с профилем и UID.
  const passes = await query<IPassRow>(
    `SELECT id, pass_number, holder_name, sigur_employee_id, card_uid, status, is_active
       FROM contractor_passes
      WHERE (status = 'applied' OR is_active = true)
        AND sigur_employee_id IS NOT NULL
        AND card_uid IS NOT NULL
      ORDER BY pass_number::int ASC`,
  );

  // 2) Опциональные фильтры (для пилота на одном пропуске).
  let candidates = passes;
  if (FILTER_NAME) {
    const needle = FILTER_NAME.toLowerCase();
    candidates = candidates.filter(p => (p.holder_name ?? '').toLowerCase().includes(needle));
  }
  if (FILTER_PASS) {
    candidates = candidates.filter(p => p.pass_number === FILTER_PASS);
  }

  console.log(`Активированных пропусков с профилем+UID: ${passes.length}` +
    (FILTER_NAME || FILTER_PASS ? ` (после фильтра: ${candidates.length})` : ''));

  // 3) Статус карты в Sigur — берём только те, где «нет карты».
  const ids = candidates.map(p => p.sigur_employee_id as number);
  const statuses = ids.length ? await getSigurEmployeeCardStatuses(ids, connection) : [];
  const stateByEmp = new Map<number, string>();
  for (const s of statuses) stateByEmp.set(s.employeeId, s.state);

  const broken = candidates.filter(p => {
    const st = stateByEmp.get(p.sigur_employee_id as number) ?? 'unknown';
    return st === 'no_card' || st === 'unknown';
  });

  console.log(`Из них без карты в Sigur (no_card/unknown): ${broken.length}\n`);

  if (broken.length === 0) {
    console.log('Нечего чинить. Выход.');
    return;
  }

  // 4) Расчёт действия по каждому + таблица.
  console.log('пропуск | ФИО | sigurEmpId | card_uid | value | W26 | действие');
  console.log('─'.repeat(120));

  interface IPlan { pass: IPassRow; value: string; w26: string; action: 'bind-only' | 'create+bind' | 'error'; note: string }
  const plans: IPlan[] = [];

  for (const p of broken) {
    let value = '—'; let w26 = '—'; let action: IPlan['action'] = 'error'; let note = '';
    try {
      const decoded = deriveCardW26(p.card_uid as string);
      value = decoded.value; w26 = decoded.w26;
      const { matches } = await sigurService.findCardByCandidates([value, p.card_uid as string], connection);
      action = matches.length > 0 ? 'bind-only' : 'create+bind';
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    plans.push({ pass: p, value, w26, action, note });
    console.log(`${p.pass_number} | ${p.holder_name ?? '—'} | ${p.sigur_employee_id} | ${p.card_uid} | ${value} | ${w26} | ${action}${note ? ` (${note})` : ''}`);
  }

  const decodeErrors = plans.filter(pl => pl.action === 'error');
  if (decodeErrors.length > 0) {
    console.log(`\n⚠ Не удалось декодировать ${decodeErrors.length} пропусков — они будут пропущены.`);
  }

  if (!APPLY) {
    console.log('\n=== СУХОЙ ПРОГОН: в Sigur ничего не записано. Для боевого режима добавьте --apply ===');
    return;
  }

  // 5) Защита от случайного массового прогона (напр. захват пула).
  if (broken.length > MAX_SAFE_COUNT && !ALLOW_COUNT_MISMATCH) {
    console.error(`\n✗ СТОП: к обработке ${broken.length} строк (> ${MAX_SAFE_COUNT}). ` +
      'Если это намеренно — повторите с --allow-count-mismatch.');
    process.exit(1);
  }

  // 6) Боевая привязка. assignSigurEmployeeCardBinding создаст карту при отсутствии.
  console.log(`\n=== БОЕВОЙ режим: обрабатываю ${plans.length - decodeErrors.length} пропусков ===`);
  let ok = 0; const fails: string[] = [];
  for (const pl of plans) {
    if (pl.action === 'error') continue;
    const p = pl.pass;
    try {
      const result = await assignSigurEmployeeCardBinding(
        p.sigur_employee_id as number,
        [p.card_uid as string],
        undefined,
        connection,
        true,
      );
      ok += 1;
      console.log(`✓ ${p.pass_number} ${p.holder_name ?? ''} — cardId=${result.card.cardId}${result.reassigned ? ' (перепривязана)' : ''}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      fails.push(`${p.pass_number} ${p.holder_name ?? ''}: ${m}`);
      console.log(`✗ ${p.pass_number} ${p.holder_name ?? ''} — ${m}`);
    }
  }

  console.log(`\n--- Итог: успешно ${ok}, ошибок ${fails.length}, пропущено (декод) ${decodeErrors.length} ---`);
  if (fails.length > 0) {
    console.log('Ошибки:');
    for (const f of fails) console.log(`  ${f}`);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
