/**
 * Разовая чистка «сдвига на единицу» в общем пуле пропусков подрядчика.
 *
 * Удаляет из пула (status='in_pool', org_department_id IS NULL) конкретные битые
 * номера и сносит их placeholder-профили в Sigur — освобождает номера для
 * корректного повторного добавления. Держателей верных карт (2553, 2559, 2890 и
 * assigned-строку 2554) НЕ трогает: фильтр строго по org IS NULL + status='in_pool'.
 *
 * По умолчанию — СУХОЙ ПРОГОН (только печать). Боевой режим — флаг --apply.
 *
 * Запуск (локально БД+Sigur — прод; на проде из build-контекста /opt/fot-build):
 *   cd fot-server && npx tsx scripts/remediate-contractor-pool-shift.ts            # dry-run
 *   cd fot-server && npx tsx scripts/remediate-contractor-pool-shift.ts --apply    # боевой
 *   ... --pass 2556          ограничить одним номером (пилот)
 *   ... --env <путь> --ca <путь>   переопределить .env / CA
 *
 * Подключение к прод-БД — по [[reference_prod_db_local_diagnostics]]:
 * чистим ssl-параметры из DATABASE_URL, передаём локальный CA, NODE_ENV=test.
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
const FILTER_PASS = flagValue('--pass');

// Битые номера (in_pool), выявленные диагностикой сдвига на +1:
//   2556-2558 — нет профиля в Sigur (карта никому не назначена);
//   2554/2555/2560/2891 — украли карту у соседа (дубль card_uid).
const TARGET_NUMBERS = ['2554', '2555', '2556', '2557', '2558', '2560', '2891'];
const MAX_SAFE_COUNT = 20; // защита от случайного массового удаления

// 1) env ДО импорта app-модулей (last-wins из .env, см. диагностический скрипт).
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

const SITE_DIR = '/srv/sites/fot.su10.ru';
const firstExisting = (paths: Array<string | null>): string | null => {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
};

const envPath = firstExisting([
  flagValue('--env'),
  path.resolve(__dirname, '../.env'),
  path.join(SITE_DIR, 'fot-server/.env'),
]);
if (!envPath) {
  console.error('Не найден .env (искал ../.env и папку сайта). Укажите --env <путь>.');
  process.exit(1);
}

const envFile = parseEnvLastWins(fs.readFileSync(envPath, 'utf8'));
const rawUrl = envFile.DATABASE_URL;
if (!rawUrl) {
  console.error(`DATABASE_URL не найден в ${envPath}`);
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

const caPath = firstExisting([
  flagValue('--ca'),
  envFile.DATABASE_SSL_CA_PATH || null,
  path.resolve(__dirname, '../../.migration/yandex-ca.pem'),
  path.join(SITE_DIR, '.migration/yandex-ca.pem'),
]);
if (!caPath) {
  console.error('Не найден CA-сертификат (yandex-ca.pem). Укажите --ca <путь>.');
  process.exit(1);
}
process.env.DATABASE_SSL_CA_PATH = caPath;
console.error(`[debug] env: ${envPath}\n[debug] ca:  ${caPath}`);

interface IPoolRow {
  id: string;
  pass_number: string;
  status: string;
  sigur_employee_id: number | null;
  card_uid: string | null;
}

async function main() {
  console.log(`=== Чистка сдвига пула (${APPLY ? 'БОЕВОЙ --apply' : 'СУХОЙ ПРОГОН'}) ===\n`);

  const { query } = await import('../src/config/postgres.js');
  const { deletePoolPasses } = await import('../src/services/contractor-pool.service.js');

  const targets = FILTER_PASS ? TARGET_NUMBERS.filter(n => n === FILTER_PASS) : TARGET_NUMBERS;
  if (targets.length === 0) {
    console.error(`--pass ${FILTER_PASS} не входит в целевой список: ${TARGET_NUMBERS.join(', ')}`);
    process.exit(1);
  }

  // Строго строки пула (org IS NULL, in_pool) — assigned-строки и держатели верных карт не попадают.
  const rows = await query<IPoolRow>(
    `SELECT id, pass_number, status, sigur_employee_id, card_uid
       FROM contractor_passes
      WHERE org_department_id IS NULL
        AND status = 'in_pool'
        AND pass_number = ANY($1::text[])
      ORDER BY pass_number::bigint ASC`,
    [targets],
  );

  console.log(`Найдено строк пула к удалению: ${rows.length} из ${targets.length} ожидаемых`);
  for (const r of rows) {
    console.log(`  № ${r.pass_number}  sigur=${r.sigur_employee_id ?? '—'}  card=${r.card_uid ?? '—'}`);
  }
  const notFound = targets.filter(n => !rows.some(r => r.pass_number === n));
  if (notFound.length) console.log(`  (уже отсутствуют в пуле: ${notFound.join(', ')})`);

  if (rows.length > MAX_SAFE_COUNT) {
    console.error(`\nСТОП: строк больше ${MAX_SAFE_COUNT} — подозрительно, прерываю.`);
    process.exit(1);
  }
  if (rows.length === 0) {
    console.log('\nНечего удалять.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nСУХОЙ ПРОГОН: ничего не удалено. Повторите с --apply для удаления.');
    process.exit(0);
  }

  const res = await deletePoolPasses(rows.map(r => r.id), 'remediation-script');
  console.log(`\nУдалено: ${res.deleted.length} (${res.deleted.join(', ')})`);
  if (res.failed.length) {
    console.log(`Не удалось: ${res.failed.length}`);
    for (const f of res.failed) console.log(`  ${f.pass_number ?? f.pass_id}: ${f.error}`);
  }
  process.exit(res.failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('Ошибка выполнения:', e);
  process.exit(1);
});
