// Read-only диагностика дублей org_departments (Sigur пересоздаёт компанию с
// новыми sigur-id → старое поддерево остаётся is_active=false осиротевшим,
// часть сотрудников «застревает» на нём, массовое назначение графика по
// бригадам молча их пропускает). Только SELECT-ы, БД не изменяется.
//
// Логика mapping (orphan → canonical) ИДЕНТИЧНА миграции
// docs/migrations/106_dedup_org_departments.sql и функции
// consolidateDuplicateDepartments() в sigur-sync-structure.service.ts:
//   для каждого name, у которого ровно одна is_active=false строка с
//   sigur_department_id IS NOT NULL и ровно одна is_active=true строка —
//   orphan = inactive, canonical = active. Неоднозначные имена не трогаем.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem
// (на проде путь к CA в .env линуксовый, локально не существует, поэтому
// собственный pg.Client с CA из репозитория). .env не модифицирует.
//
// Usage: node fot-server/scripts/diagnose-dup-departments.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
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

// CTE строит orphan→canonical маппинг. Те же условия применяет миграция 106.
const MAPPING_CTE = `
WITH dup AS (
  SELECT name FROM org_departments
   GROUP BY name
  HAVING count(*) FILTER (WHERE is_active = false AND sigur_department_id IS NOT NULL) = 1
     AND count(*) FILTER (WHERE is_active = true) = 1
),
mapping AS (
  SELECT orphan.id AS orphan_id, canon.id AS canonical_id, orphan.name AS name,
         orphan.sigur_department_id AS orphan_sigur, canon.sigur_department_id AS canon_sigur
    FROM dup
    JOIN org_departments orphan
      ON orphan.name = dup.name AND orphan.is_active = false AND orphan.sigur_department_id IS NOT NULL
    JOIN org_departments canon
      ON canon.name = dup.name AND canon.is_active = true
)`;

function section(t) { console.log(`\n=== ${t} ===`); }

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  console.log(`connected (${rep.rows[0].r ? 'replica' : 'PRIMARY'})`);

  section('1. Маппинг orphan → canonical (что схлопнёт миграция 106)');
  const map = (await client.query(`${MAPPING_CTE}
    SELECT m.name, m.orphan_id, m.orphan_sigur, m.canonical_id, m.canon_sigur,
           (SELECT count(*) FROM employees e WHERE e.org_department_id = m.orphan_id) AS emp_on_orphan
      FROM mapping m ORDER BY m.name`)).rows;
  console.log(`  пар к схлопыванию: ${map.length}`);
  for (const r of map) {
    console.log(`  "${r.name}" orphan=${r.orphan_id}(sigur=${r.orphan_sigur}, emp=${r.emp_on_orphan}) -> canonical=${r.canonical_id}(sigur=${r.canon_sigur})`);
  }

  section('2. Сотрудники, «застрявшие» на is_active=false (молча теряются при назначении)');
  const stranded = (await client.query(`
    SELECT count(*) AS stranded_total
      FROM employees e
      JOIN org_departments od ON od.id = e.org_department_id
     WHERE od.is_active = false
       AND e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired'`)).rows[0];
  console.log(`  активных сотрудников на is_active=false отделах: ${stranded.stranded_total}`);
  const strandedInMap = (await client.query(`${MAPPING_CTE}
    SELECT count(*) AS n
      FROM employees e JOIN mapping m ON m.orphan_id = e.org_department_id
     WHERE e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired'`)).rows[0];
  console.log(`  из них будут перенесены миграцией 106: ${strandedInMap.n}`);

  section('3. Неоднозначные имена (>1 строки, НЕ покрыты маппингом — ручной разбор)');
  const ambiguous = (await client.query(`${MAPPING_CTE}
    SELECT od.name,
           count(*) FILTER (WHERE od.is_active) AS actives,
           count(*) FILTER (WHERE NOT od.is_active) AS inactives,
           count(*) FILTER (WHERE NOT od.is_active AND od.sigur_department_id IS NOT NULL) AS inactive_with_sigur
      FROM org_departments od
     WHERE od.name NOT IN (SELECT name FROM mapping)
     GROUP BY od.name HAVING count(*) > 1
     ORDER BY od.name`)).rows;
  console.log(`  неоднозначных имён: ${ambiguous.length}`);
  for (const r of ambiguous.slice(0, 40)) {
    console.log(`  "${r.name}" active=${r.actives} inactive=${r.inactives} inactive_with_sigur=${r.inactive_with_sigur}`);
  }

  section('4. Инварианты ПОСЛЕ применения миграции должны стать нулевыми');
  const split = (await client.query(`
    SELECT count(*) AS split_names FROM (
      SELECT od.name
        FROM org_departments od
        JOIN employees e ON e.org_department_id = od.id
         AND e.is_archived = false AND e.excluded_from_timesheet = false AND e.employment_status <> 'fired'
       GROUP BY od.name
      HAVING count(DISTINCT od.id) > 1
    ) z`)).rows[0];
  console.log(`  имён с активными сотрудниками на >1 строке (должно стать 0): ${split.split_names}`);
  const dupSigur = (await client.query(`
    SELECT count(*) AS n FROM (
      SELECT sigur_department_id FROM org_departments
       WHERE sigur_department_id IS NOT NULL
       GROUP BY sigur_department_id HAVING count(*) > 1) z`)).rows[0];
  console.log(`  дубли sigur_department_id (должно быть 0 для UNIQUE-индекса): ${dupSigur.n}`);

  section('5. Контроль двух названных бригад');
  const named = (await client.query(`
    SELECT od.id, od.name, od.is_active, od.sigur_department_id,
           (SELECT count(*) FROM employees e
             WHERE e.org_department_id=od.id AND e.is_archived=false
               AND e.excluded_from_timesheet=false AND e.employment_status<>'fired') AS bulk_match
      FROM org_departments od
     WHERE od.name ILIKE '%курбоншоев%' OR od.name ILIKE '%махмадиев%'
     ORDER BY od.name, od.is_active`)).rows;
  for (const r of named) {
    console.log(`  "${r.name}" active=${r.is_active} sigur=${r.sigur_department_id} bulk_match=${r.bulk_match} id=${r.id}`);
  }

  console.log('\nГотово (изменения в БД не вносились).');
}

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
try {
  await client.connect();
  await run(client);
  await client.end();
  process.exit(0);
} catch (err) {
  console.error(`Ошибка диагностики: ${err?.message ?? err}`);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
}
