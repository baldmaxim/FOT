// Однократный backfill: переписывает старые day-level корректировки
// (`attendance_adjustments.source_type='manual'`, status в ('work','manual'))
// в per-object (`source_type='manual_object'`) по правилу «объект с наибольшим
// числом СКУД-событий сотрудника в этот день».
//
// Идемпотентен: после успешного прогона у мигрированных строк source_type='manual_object',
// повторный запуск их уже не подберёт.
//
// Usage:
//   cd fot-server
//   node scripts/migrate-day-level-to-object-corrections.mjs [--dry-run]
//
// Env-файл и CA читаются автоматически:
//   - .env: $FOT_REPO_ROOT/fot-server/.env, либо ../fot-server/.env от скрипта,
//           либо $PWD/.env.
//   - CA:   $FOT_REPO_ROOT/.migration/yandex-ca.pem, либо ../.migration/yandex-ca.pem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');

const REPO_ROOT = process.env.FOT_REPO_ROOT
  || path.resolve(__dirname, '..', '..'); // <repo>/fot-server/scripts -> <repo>

const ENV_CANDIDATES = [
  path.resolve(REPO_ROOT, 'fot-server', '.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
];
const CA_CANDIDATES = [
  path.resolve(REPO_ROOT, '.migration', 'yandex-ca.pem'),
  path.resolve(__dirname, '..', '..', '.migration', 'yandex-ca.pem'),
];

function firstExisting(paths) {
  for (const p of paths) {
    try { fs.accessSync(p, fs.constants.R_OK); return p; } catch { /* пропуск */ }
  }
  return null;
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const envPath = firstExisting(ENV_CANDIDATES);
if (!envPath) {
  console.error('[migrate] .env не найден. Проверь пути:');
  for (const p of ENV_CANDIDATES) console.error(`  - ${p}`);
  process.exit(2);
}
const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const dbUrl = env.DATABASE_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.error(`[migrate] DATABASE_URL не задан (.env: ${envPath})`); process.exit(2); }

const caPath = firstExisting(CA_CANDIDATES);
const ca = caPath ? fs.readFileSync(caPath, 'utf8') : null;

// Чистим SSL-параметры из connection string — задаём через ssl-объект.
let connStr = dbUrl;
let host = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  host = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* connStr остаётся как есть */ }

const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
const client = new Client({ connectionString: connStr, ssl });

const OBJECT_ADJUSTMENT_SOURCE_TYPE = 'manual_object';

const REPORT_PATH = path.resolve(
  __dirname,
  `migrate-day-level-to-object-corrections.report.${Date.now()}.json`,
);

async function main() {
  console.log(`[migrate] dry-run = ${DRY_RUN}`);
  console.log(`[migrate] env: ${envPath}`);
  console.log(`[migrate] ca:  ${caPath || '(none — sslmode=relaxed)'}`);
  console.log(`[migrate] db:  ${host}`);

  await client.connect();

  const candidatesRes = await client.query(
    `SELECT id, employee_id, work_date::text AS work_date, status, hours_override, reason, metadata
       FROM attendance_adjustments
      WHERE source_type = 'manual'
        AND status IN ('work', 'manual')
        AND hours_override IS NOT NULL
        AND hours_override > 0
      ORDER BY work_date DESC, employee_id ASC, id ASC`,
  );
  const candidates = candidatesRes.rows;
  console.log(`[migrate] кандидатов: ${candidates.length}`);

  const report = [];
  let migrated = 0;
  let merged = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    const adjustmentId = Number(row.id);
    const hoursOverride = Number(row.hours_override);
    const base = {
      adjustment_id: adjustmentId,
      employee_id: row.employee_id,
      work_date: row.work_date,
      hours_override: hoursOverride,
      action: 'skipped_no_skud',
    };

    let picked = null;
    try {
      const r = await client.query(
        `SELECT sap.object_id::text AS object_id,
                so.name AS object_name,
                COUNT(*)::int AS event_count
           FROM skud_events se
           JOIN skud_object_access_points sap
                ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
           JOIN skud_objects so
                ON so.id = sap.object_id
               AND so.is_active = TRUE
          WHERE se.employee_id = $1
            AND se.event_date = $2::date
            AND se.access_point IS NOT NULL
          GROUP BY sap.object_id, so.name
          ORDER BY event_count DESC, so.name ASC
          LIMIT 1`,
        [row.employee_id, row.work_date],
      );
      if (r.rows.length > 0) {
        picked = {
          object_id: r.rows[0].object_id,
          object_name: r.rows[0].object_name,
          event_count: Number(r.rows[0].event_count),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] id=${adjustmentId} SKUD lookup error: ${msg}`);
      report.push({ ...base, action: 'error', error: msg });
      errors += 1;
      continue;
    }

    if (!picked) {
      report.push(base);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      report.push({
        ...base,
        action: 'migrated',
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        picked_event_count: picked.event_count,
      });
      migrated += 1;
      continue;
    }

    try {
      await client.query('BEGIN');
      const existingRes = await client.query(
        `SELECT id FROM attendance_adjustments
           WHERE employee_id = $1
             AND work_date = $2
             AND source_type = $3
             AND source_id = $4
           LIMIT 1`,
        [row.employee_id, row.work_date, OBJECT_ADJUSTMENT_SOURCE_TYPE, picked.object_id],
      );

      let action;
      if (existingRes.rowCount > 0) {
        // Уже есть manual_object на этот (emp, date, object) — manual_object авторитетна,
        // day-level удаляем.
        await client.query(`DELETE FROM attendance_adjustments WHERE id = $1`, [adjustmentId]);
        action = 'merged_into_existing';
      } else {
        const nextMeta = {
          ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
          object_id: picked.object_id,
          object_name: picked.object_name,
          migrated_from_day_level: true,
          migrated_at: new Date().toISOString(),
        };
        await client.query(
          `UPDATE attendance_adjustments
              SET source_type = $1,
                  source_id   = $2,
                  status      = 'manual',
                  metadata    = $3::jsonb,
                  updated_at  = now()
            WHERE id = $4`,
          [OBJECT_ADJUSTMENT_SOURCE_TYPE, picked.object_id, JSON.stringify(nextMeta), adjustmentId],
        );
        action = 'migrated';
      }
      await client.query('COMMIT');

      report.push({
        ...base,
        action,
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        picked_event_count: picked.event_count,
      });
      if (action === 'merged_into_existing') merged += 1; else migrated += 1;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* пропуск */ }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] id=${adjustmentId} UPDATE/DELETE error: ${msg}`);
      report.push({
        ...base,
        action: 'error',
        picked_object_id: picked.object_id,
        picked_object_name: picked.object_name,
        error: msg,
      });
      errors += 1;
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    dry_run: DRY_RUN,
    total: candidates.length,
    migrated,
    merged_into_existing: merged,
    skipped_no_skud: skipped,
    errors,
    items: report,
  }, null, 2));

  console.log(`[migrate] migrated=${migrated} merged=${merged} skipped=${skipped} errors=${errors}`);
  console.log(`[migrate] отчёт: ${REPORT_PATH}`);
  if (DRY_RUN) {
    console.log('[migrate] DRY-RUN: БД не изменялась. Запусти без --dry-run для применения.');
  }
  await client.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[migrate] fatal:', err);
  try { await client.end(); } catch { /* пропуск */ }
  process.exit(1);
});
