// Чистка дубликатов contractor_passes.pass_number: для каждой пары
// (assigned-старая-orphan + in_pool-новая) помечаем старую запись как
// status='revoked', чтобы освободить pass_number в индексе
// contractor_passes_pool_pass_number_uniq.
//
// Контекст: пропуска №01-10 для СТРОЙСЕРВИС ООО завели в Sigur, потом профили
// 143521-143531 руками удалили и перезавели в новой папке (143605-143613).
// В БД остались висеть 9 старых записей со status=assigned и orphan-sigur_id.
//
// По умолчанию dry-run. Для реального выполнения: --apply
//
// Usage:
//   node fot-server/scripts/cleanup-duplicate-pass-numbers.mjs            # dry-run
//   node fot-server/scripts/cleanup-duplicate-pass-numbers.mjs --apply    # выполнить

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const APPLY = process.argv.includes('--apply');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[k] = v;
  }
  return out;
}

const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const dbUrl = env.DATABASE_URL;
if (!dbUrl) { console.error('Missing DATABASE_URL in fot-server/.env'); process.exit(2); }
const ca = fs.readFileSync(CA_PATH, 'utf8');

let connStr = dbUrl;
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  u.searchParams.set('target_session_attrs', 'read-write');
  connStr = u.toString();
} catch { /* ignore */ }

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });

// Стратегия выбора "лишней" записи:
// 1. В группе с одинаковым pass_number должно остаться одна запись со status=in_pool.
// 2. "Лишние" - все записи со status='assigned'/'applied'/'submitted'/'blocked',
//    у которых ЕСТЬ парная in_pool-запись с тем же pass_number И тем же card_uid
//    (значит карта физически перевыпущена в новой папке Sigur, старая запись orphan).
const SELECT_ORPHANS_SQL = `
  WITH pool AS (
    SELECT pass_number, card_uid, id AS pool_id, sigur_employee_id AS pool_sigur
      FROM contractor_passes
     WHERE status = 'in_pool' AND org_department_id IS NULL
  ),
  candidates AS (
    SELECT p.id, p.pass_number, p.status, p.holder_name, p.sigur_employee_id, p.card_uid,
           pool.pool_id, pool.pool_sigur
      FROM contractor_passes p
      JOIN pool ON pool.pass_number = p.pass_number AND pool.card_uid = p.card_uid
     WHERE p.org_department_id IS NOT NULL
       AND p.status IN ('assigned','submitted','applied','blocked')
  )
  SELECT * FROM candidates ORDER BY pass_number::int
`;

const UPDATE_SQL = `
  UPDATE contractor_passes
     SET status = 'revoked',
         sigur_employee_id = NULL,
         is_active = false,
         updated_at = now()
   WHERE id = $1::uuid
`;

try {
  await client.connect();

  const rows = (await client.query(SELECT_ORPHANS_SQL)).rows;
  console.log(`Кандидатов на чистку: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  pass=${r.pass_number} id=${r.id} status=${r.status} ` +
      `holder='${r.holder_name ?? '-'}' sigur=${r.sigur_employee_id} card=${r.card_uid} ` +
      `→ ставим status='revoked', sigur_employee_id=NULL` +
      `   (актуальная in_pool: id=${r.pool_id}, sigur=${r.pool_sigur})`,
    );
  }

  if (rows.length === 0) {
    console.log('Нечего чистить.');
  } else if (!APPLY) {
    console.log('\n(dry-run) Запустите с --apply для реального выполнения.');
  } else {
    console.log('\nВыполняю UPDATE в транзакции…');
    await client.query('BEGIN');
    try {
      let updated = 0;
      for (const r of rows) {
        const res = await client.query(UPDATE_SQL, [r.id]);
        updated += res.rowCount;
      }
      await client.query('COMMIT');
      console.log(`Готово. UPDATE затронул строк: ${updated}.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
} finally {
  await client.end();
}
