// Чистка дублей day-level корректировок: на один (employee_id, work_date) бывает
// несколько записей в attendance_adjustments РАЗНЫХ источников (manual ↔ leave_request
// ↔ legacy_tender_timesheet). Из-за этого день показывался дважды / файл из заявки
// не был виден (показывалась ручная запись-дубль). Скрипт оставляет ОДНУ запись на
// день, переносит вложения на выжившую и удаляет остальные.
//
// Выживает запись с максимумом разрешимых вложений (own document_links +
// файлы связанной заявки); при равенстве — более свежая (updated_at).
// manual_object (по-объектные) НЕ трогаем — их на день может быть несколько.
//
// Usage:
//   node fot-server/scripts/dedup-day-level-adjustments.mjs --dry-run
//   node fot-server/scripts/dedup-day-level-adjustments.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const ENTITY = 'attendance_adjustment';
const PURPOSE = 'timesheet_correction';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

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
let sanitizedHost = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });
await client.connect();
console.log(`БД: ${sanitizedHost}`);
console.log(`Режим: ${dryRun ? 'DRY-RUN (без изменений)' : 'APPLY'}`);

// Группы (employee_id, work_date) с >1 day-level записью (исключая manual_object).
const groups = (await client.query(
  `SELECT employee_id, work_date::text AS work_date, COUNT(*)::int AS cnt
     FROM attendance_adjustments
    WHERE source_type <> 'manual_object'
    GROUP BY employee_id, work_date
   HAVING COUNT(*) > 1
    ORDER BY employee_id, work_date`,
)).rows;

console.log(`\nГрупп с дублями day-level: ${groups.length}`);

// Кол-во разрешимых вложений у строки: own document_links + файлы заявки (для leave_request).
async function attachmentCount(row) {
  const own = (await client.query(
    `SELECT COUNT(*)::int AS n FROM document_links
      WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [ENTITY, String(row.id), PURPOSE],
  )).rows[0].n;
  let lr = 0;
  if (row.source_type === 'leave_request' && row.source_id) {
    const lrId = String(row.source_id).split(':')[0];
    if (/^\d+$/.test(lrId)) {
      const links = (await client.query(
        `SELECT COUNT(*)::int AS n FROM document_links WHERE entity_type = 'leave_request' AND entity_id = $1`,
        [lrId],
      )).rows[0].n;
      const legacy = (await client.query(
        `SELECT COUNT(*)::int AS n FROM documents WHERE leave_request_id = $1::int`,
        [lrId],
      )).rows[0].n;
      lr = Math.max(links, legacy);
    }
  }
  return own + lr;
}

let groupsTouched = 0;
let rowsRemoved = 0;
let linksMigrated = 0;

for (const g of groups) {
  const rows = (await client.query(
    `SELECT id, source_type, source_id, status, hours_override, updated_at::text AS updated_at
       FROM attendance_adjustments
      WHERE employee_id = $1 AND work_date = $2 AND source_type <> 'manual_object'
      ORDER BY updated_at DESC`,
    [g.employee_id, g.work_date],
  )).rows;
  if (rows.length < 2) continue;

  // Выбор выжившей: максимум вложений, затем самая свежая (rows уже DESC по updated_at).
  let survivor = rows[0];
  let bestCount = await attachmentCount(rows[0]);
  for (const r of rows.slice(1)) {
    const c = await attachmentCount(r);
    if (c > bestCount) { survivor = r; bestCount = c; }
  }

  const losers = rows.filter(r => r.id !== survivor.id);
  groupsTouched += 1;
  console.log(
    `  emp=${g.employee_id} ${g.work_date}: выживает #${survivor.id} (${survivor.source_type}, влож=${bestCount}); ` +
    `удаляются [${losers.map(l => `#${l.id}/${l.source_type}`).join(', ')}]`,
  );

  if (dryRun) { rowsRemoved += losers.length; continue; }

  for (const loser of losers) {
    // Собственные вложения проигравшей → выжившей.
    const m1 = (await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         SELECT document_id, $1, $2, $3 FROM document_links
          WHERE entity_type = $1 AND entity_id = $4 AND purpose = $3
       ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING
       RETURNING document_id`,
      [ENTITY, String(survivor.id), PURPOSE, String(loser.id)],
    )).rows;
    linksMigrated += m1.length;
    // Файлы заявки проигравшей (leave_request) → как собственные ссылки выжившей.
    if (loser.source_type === 'leave_request' && loser.source_id) {
      const lrId = String(loser.source_id).split(':')[0];
      if (/^\d+$/.test(lrId)) {
        const m2 = (await client.query(
          `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
             SELECT document_id, $1, $2, $3 FROM document_links
              WHERE entity_type = 'leave_request' AND entity_id = $4
           ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING
           RETURNING document_id`,
          [ENTITY, String(survivor.id), PURPOSE, lrId],
        )).rows;
        linksMigrated += m2.length;
      }
    }
    // Осиротевшие ссылки проигравшей и сама строка.
    await client.query(
      `DELETE FROM document_links WHERE entity_type = $1 AND entity_id = $2`,
      [ENTITY, String(loser.id)],
    );
    await client.query(`DELETE FROM attendance_adjustments WHERE id = $1`, [loser.id]);
    rowsRemoved += 1;
  }
}

console.log('\n=== ИТОГ ===');
console.log(`  Групп с дублями:        ${groups.length}`);
console.log(`  Групп обработано:       ${groupsTouched}`);
console.log(`  ${dryRun ? 'Будет удалено строк' : 'Удалено строк'}:    ${rowsRemoved}`);
if (!dryRun) console.log(`  Перенесено ссылок:      ${linksMigrated}`);

await client.end();
