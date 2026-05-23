// Ремедиация бага «одобренный пользователь видит "Ожидание одобрения"».
//
// Причина: в очереди на одобрение раньше показывались orphan-профили (строка
// user_profiles без app_auth.users). Админ одобрял orphan, а логин ходит через
// app_auth.users → актуальную login-строку, которая осталась is_approved=false.
//
// Скрипт находит пострадавших по audit-логу USER_APPROVED: если одобренный
// profile-id — orphan, ищет актуальную login-строку того же человека (по ФИО)
// и проставляет ей is_approved=true с ролью, которую админ выбрал при одобрении.
//
// Orphan-строки НЕ удаляются (миграция 097 каскадит user_profiles → дочерние,
// удаление = потеря данных). От повторного перехвата защищает фикс getPendingUsers.
//
// По умолчанию --dry-run (только отчёт). Реальная запись — флаг --apply.
// Идемпотентен: повторный прогон уже починенных строк пропускает.
//
// Берёт DATABASE_URL из fot-server/.env и CA из .migration/yandex-ca.pem
// (как diagnose-user-approval.mjs). .env не модифицирует.
//
// Usage:
//   node fot-server/scripts/fix-orphan-approved-users.mjs            # dry-run
//   node fot-server/scripts/fix-orphan-approved-users.mjs --apply    # запись

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

// Из строки подключения убираем ssl*-параметры: pg-connection-string при
// создании Client делает readFileSync(sslrootcert) — линуксовый путь прода.
let connStr = dbUrl;
let sanitizedHost = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) {
    u.searchParams.delete(p);
  }
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`Режим: ${APPLY ? 'APPLY (запись в БД)' : 'DRY-RUN (только отчёт)'}\n`);

  const roles = (await client.query('SELECT id, code FROM system_roles')).rows;
  const roleIdByCode = new Map(roles.map(r => [r.code, r.id]));

  // Последняя по времени запись USER_APPROVED на каждый profile-id.
  const approvals = (await client.query(
    `SELECT DISTINCT ON (entity_id::text)
            entity_id::text AS entity_id, user_id, details, created_at
       FROM audit_logs
      WHERE action = 'USER_APPROVED'
      ORDER BY entity_id::text, created_at DESC`,
  )).rows;
  console.log(`USER_APPROVED записей (уникальных profile-id): ${approvals.length}`);

  const fixes = [];   // готовые к применению
  const manual = [];  // требуют ручной разборки
  let okCount = 0;

  for (const a of approvals) {
    const approvedId = a.entity_id;

    // Одобрен login-capable профиль → корректно, пропускаем.
    const authRow = (await client.query(
      'SELECT 1 FROM app_auth.users WHERE id = $1::uuid', [approvedId],
    )).rows[0];
    if (authRow) { okCount++; continue; }

    // Одобрен orphan. Грузим orphan-профиль (мог быть удалён reject'ом).
    const orphan = (await client.query(
      `SELECT id, full_name, system_role_id, employee_id, approved_by, approved_at
         FROM user_profiles WHERE id = $1::uuid`, [approvedId],
    )).rows[0];
    if (!orphan) continue; // orphan-профиль удалён — чинить нечего
    if (!orphan.full_name || !orphan.full_name.trim()) {
      manual.push({ approvedId, reason: 'у orphan-профиля пустое ФИО — не сопоставить' });
      continue;
    }

    // Актуальная login-строка того же человека по точному ФИО.
    const candidates = (await client.query(
      `SELECT up.id, up.full_name, up.is_approved, up.system_role_id, up.employee_id
         FROM user_profiles up
         JOIN app_auth.users au ON au.id = up.id
        WHERE up.full_name = $1`, [orphan.full_name],
    )).rows;

    if (candidates.length === 0) {
      manual.push({ approvedId, fullName: orphan.full_name, reason: 'нет login-строки — человек не зарегистрирован заново' });
      continue;
    }
    if (candidates.length > 1) {
      manual.push({ approvedId, fullName: orphan.full_name, reason: `несколько login-строк (${candidates.length}) — разобрать вручную` });
      continue;
    }

    const cand = candidates[0];
    if (cand.is_approved) { okCount++; continue; } // уже починено / уже одобрен

    // Роль: из audit.details.position_type (что выбрал админ), fallback — orphan.
    const posCode = a.details && typeof a.details === 'object' ? a.details.position_type : null;
    const roleId = (posCode && roleIdByCode.get(posCode)) || orphan.system_role_id;

    fixes.push({
      candidateId: cand.id,
      orphanId: approvedId,
      fullName: orphan.full_name,
      roleId,
      roleCode: posCode || '<из orphan>',
      employeeId: orphan.employee_id ?? cand.employee_id ?? null,
      approvedBy: a.user_id ?? orphan.approved_by ?? null,
      approvedAt: orphan.approved_at ?? a.created_at,
    });
  }

  console.log(`Корректных одобрений: ${okCount}`);
  console.log(`К починке: ${fixes.length}`);
  console.log(`На ручную разборку: ${manual.length}\n`);

  for (const m of manual) {
    console.log(`  [manual] profile=${m.approvedId} ФИО="${m.fullName ?? '?'}" — ${m.reason}`);
  }
  if (manual.length > 0) console.log('');

  for (const f of fixes) {
    console.log(`  [fix] "${f.fullName}" login-строка ${f.candidateId} ← is_approved=true `
      + `role=${f.roleCode} employee_id=${f.employeeId ?? 'NULL'} (orphan ${f.orphanId})`);
    if (!APPLY) continue;

    await client.query(
      `UPDATE user_profiles
          SET is_approved = true,
              system_role_id = COALESCE($2::uuid, system_role_id),
              employee_id = COALESCE(employee_id, $3),
              approved_by = COALESCE(approved_by, $4::uuid),
              approved_at = COALESCE(approved_at, $5::timestamptz)
        WHERE id = $1::uuid AND is_approved = false`,
      [f.candidateId, f.roleId, f.employeeId, f.approvedBy, f.approvedAt],
    );
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'USER_APPROVED', 'user', $2, $3::jsonb)`,
      [f.approvedBy, f.candidateId, JSON.stringify({
        remediation: true,
        reason: 'orphan-approved-users fix',
        orphan_profile_id: f.orphanId,
        position_type: f.roleCode,
      })],
    );
  }

  console.log('');
  if (fixes.length === 0) {
    console.log('Нечего чинить.');
  } else if (APPLY) {
    console.log(`Готово: починено ${fixes.length} строк.`);
  } else {
    console.log('DRY-RUN — изменений не вносилось. Для записи: --apply');
  }
}

const client = new Client({
  connectionString: connStr,
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});
try {
  await client.connect();
  const rep = await client.query('SELECT pg_is_in_recovery() AS r');
  if (rep.rows[0].r) {
    console.error('Подключение к РЕПЛИКЕ — запись невозможна. Нужен PRIMARY.');
    await client.end();
    process.exit(1);
  }
  console.log('connected (PRIMARY)');
  await run(client);
  await client.end();
  process.exit(0);
} catch (err) {
  console.error(`Ошибка: ${err?.message ?? err}`);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
}
