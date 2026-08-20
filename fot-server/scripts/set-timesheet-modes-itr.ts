/**
 * Настройка режимов табелирования по списку «ИТР-объекты» из 1С (миграция 249).
 *
 * Пишет ТОЛЬКО новые поля org_departments/employees.timesheet_export_mode.
 * `department_object_assignment` и `employee_object_assignment` не трогает — они участвуют
 * в скоупе табельщиц (timekeeper-scope.service.ts:212, data-scope, timesheet-scope), и любое
 * их изменение меняло бы права. Именно поэтому настройка идёт новыми полями.
 *
 * Что делает:
 *   9 отделов  → timesheet_export_mode = 'skud'            (были на «текущей деятельности»)
 *   7 человек  → timesheet_export_mode = 'current_activity' (личные исключения по списку 1С)
 *
 * НЕ трогает: 8 отделов, уже работающих по СКУД; «Отдел управления проектированием управления
 * фасадов» (там Цурко и Галеев, которым нужна ТД); Колганова З.В. — у него legacy-ТД, дающая
 * нужный результат.
 *
 * Гарантии:
 *   - preflight: сверка uuid ↔ название ↔ активность, наличие actor, целевые поля ещё NULL;
 *   - advisory lock → SELECT ... FOR UPDATE → снимок «до» (в таком порядке, иначе снимок
 *     может устареть между чтением и записью); тот же ключ берут PUT-эндпоинты режима;
 *   - вся запись в одной транзакции, аудит через logWithClient;
 *   - post-check: изменились ровно ожидаемые строки;
 *   - откат: --rollback <файл снимка>.
 *
 * Запуск (локально, БД — прод; подключение по приёму [[reference_prod_db_local_diagnostics]]):
 *   npx tsx scripts/set-timesheet-modes-itr.ts                       # dry-run
 *   npx tsx scripts/set-timesheet-modes-itr.ts --apply --actor-user-id=<uuid>
 *   npx tsx scripts/set-timesheet-modes-itr.ts --rollback temp/rollback_timesheet_modes_<ts>.json --actor-user-id=<uuid>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// env ДО импорта app-модулей (как в scripts/profile-unified-export.ts).
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

/** Отделы, переводимые на разбивку по СКУД. uuid зашиты — имена сверяются в preflight. */
const TARGET_DEPARTMENTS: Array<{ id: string; name: string; expectedActive: number }> = [
  { id: '85aed030-8623-42df-beca-25cf43b47c77', name: 'Геодезическая служба', expectedActive: 20 },
  { id: 'caa430cb-d2c8-4282-9dc4-d9e129b2ca69', name: 'Экономический сектор', expectedActive: 17 },
  { id: '7d51d468-add3-4fe8-a613-69bc8210f887', name: 'Отдел по охране труда и технике безопасности', expectedActive: 15 },
  { id: '47f45cbb-c168-451a-90d0-0975de59f787', name: 'Секретариат-Объекты', expectedActive: 8 },
  { id: '6e251dcd-6097-42e6-8a72-156d5122d257', name: 'Комендантская служба', expectedActive: 6 },
  { id: '353c8b36-96b3-4fdf-94c8-f3fa528580ec', name: 'Отдел табельного учёта', expectedActive: 5 },
  { id: 'c1d95c50-9bd8-4f76-8a45-eff44b1d7884', name: 'Отдел диспетчерской службы', expectedActive: 5 },
  { id: '51714bee-56f4-453e-9f0f-ae9ce6124af1', name: 'Отдел ИД/офис', expectedActive: 3 },
  { id: '3b8e5dd2-9d0e-40aa-a9d5-5dec54ecfc4b', name: 'Группа оказания первой помощи', expectedActive: 1 },
];

/** Личные исключения: остаются на «текущей деятельности» внутри skud-отделов. */
const TARGET_EMPLOYEES: Array<{ id: number; name: string; departmentName: string }> = [
  { id: 8783, name: 'Орешкин Павел Олегович', departmentName: 'Отдел по охране труда и технике безопасности' },
  { id: 483, name: 'Гриценко Андрей Владимирович', departmentName: 'Отдел по охране труда и технике безопасности' },
  { id: 1757, name: 'Тихонович Юрий Викторович', departmentName: 'Геодезическая служба' },
  { id: 1633, name: 'Свинцицкая Анастасия Геннадьевна', departmentName: 'Геодезическая служба' },
  { id: 1978, name: 'Хачатуров Самвел Александрович', departmentName: 'Отдел проектирования и согласования' },
  { id: 1897, name: 'Федянов Александр Александрович', departmentName: 'Экономический сектор' },
  { id: 1655, name: 'Ситдиков Родион Анварович', departmentName: 'Управление фасадов' },
];

interface ISnapshot {
  created_at: string;
  departments: Array<{ id: string; mode: string | null; object_id: string | null }>;
  employees: Array<{ id: number; mode: string | null; object_id: string | null }>;
}

const argValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

async function main(): Promise<void> {
  const { query, queryOne, withTransaction } = await import('../src/config/postgres.js');
  const { auditService, AUDIT_ACTIONS } = await import('../src/services/audit.service.js');
  const { TIMESHEET_MODE_LOCK_KEY } = await import('../src/services/timesheet-export-mode.service.js');

  const apply = process.argv.includes('--apply');
  const rollbackFile = argValue('rollback');
  const actorUserId = argValue('actor-user-id') ?? null;

  if ((apply || rollbackFile) && !actorUserId) {
    throw new Error('--actor-user-id обязателен для --apply и --rollback');
  }
  if (actorUserId) {
    const actor = await queryOne<{ id: string }>('SELECT id FROM app_auth.users WHERE id = $1::uuid', [actorUserId]);
    if (!actor) throw new Error(`Пользователь ${actorUserId} не найден`);
  }

  if (rollbackFile) {
    await runRollback(rollbackFile, actorUserId!, { withTransaction, auditService, AUDIT_ACTIONS, TIMESHEET_MODE_LOCK_KEY });
    return;
  }

  // ── Preflight ──────────────────────────────────────────────────────────────
  // Миграция 249 могла быть не применена — без неё запросы упали бы сырой ошибкой БД.
  const columns = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name IN ('timesheet_export_mode', 'timesheet_export_object_id')
        AND table_name IN ('employees', 'org_departments')`,
  );
  if (columns.length < 4) {
    console.error('Миграция 249 не применена: нет колонок timesheet_export_mode / timesheet_export_object_id.');
    console.error('Примените docs/migrations/249_timesheet_export_mode.sql и повторите.');
    process.exit(1);
  }

  const problems: string[] = [];

  const deptRows = await query<{
    id: string; name: string; is_active: boolean;
    timesheet_export_mode: string | null; timesheet_export_object_id: string | null; active_cnt: string;
  }>(
    `SELECT d.id::text, d.name, d.is_active, d.timesheet_export_mode, d.timesheet_export_object_id::text,
            (SELECT count(*) FROM employees e
              WHERE e.org_department_id = d.id AND e.is_archived = false AND e.employment_status = 'active') AS active_cnt
       FROM org_departments d WHERE d.id = ANY($1::uuid[])`,
    [TARGET_DEPARTMENTS.map(d => d.id)],
  );
  const deptById = new Map(deptRows.map(r => [r.id, r]));

  for (const target of TARGET_DEPARTMENTS) {
    const row = deptById.get(target.id);
    if (!row) { problems.push(`отдел ${target.id} (${target.name}) не найден`); continue; }
    if (row.name !== target.name) problems.push(`отдел ${target.id}: имя «${row.name}» ≠ ожидаемого «${target.name}»`);
    if (!row.is_active) problems.push(`отдел «${row.name}» неактивен`);
    // Явно заданный режим не перезаписываем: его мог поставить HR через UI.
    if (row.timesheet_export_mode !== null) {
      problems.push(`отдел «${row.name}»: режим уже задан вручную (${row.timesheet_export_mode}) — скрипт не перезаписывает`);
    }
    if (Number(row.active_cnt) !== target.expectedActive) {
      console.warn(`  ⚠ отдел «${row.name}»: активных ${row.active_cnt}, ожидалось ${target.expectedActive} (состав мог измениться)`);
    }
  }

  const empRows = await query<{
    id: number; full_name: string; employment_status: string; is_archived: boolean;
    dept_name: string | null; timesheet_export_mode: string | null; timesheet_export_object_id: string | null;
  }>(
    `SELECT e.id, e.full_name, e.employment_status, e.is_archived,
            d.name AS dept_name, e.timesheet_export_mode, e.timesheet_export_object_id::text
       FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.id = ANY($1::int[])`,
    [TARGET_EMPLOYEES.map(e => e.id)],
  );
  const empById = new Map(empRows.map(r => [Number(r.id), r]));

  for (const target of TARGET_EMPLOYEES) {
    const row = empById.get(target.id);
    if (!row) { problems.push(`сотрудник ${target.id} (${target.name}) не найден`); continue; }
    if (row.full_name !== target.name) problems.push(`сотрудник ${target.id}: ФИО «${row.full_name}» ≠ ожидаемого «${target.name}»`);
    if (row.is_archived || row.employment_status !== 'active') problems.push(`сотрудник «${row.full_name}» неактивен (${row.employment_status})`);
    if (row.dept_name !== target.departmentName) {
      problems.push(`сотрудник «${row.full_name}»: отдел «${row.dept_name}» ≠ ожидаемого «${target.departmentName}»`);
    }
    if (row.timesheet_export_mode !== null) {
      problems.push(`сотрудник «${row.full_name}»: режим уже задан вручную (${row.timesheet_export_mode}) — скрипт не перезаписывает`);
    }
  }

  console.log('=== План изменений ===');
  console.log(`Отделы → skud (${TARGET_DEPARTMENTS.length}):`);
  for (const d of TARGET_DEPARTMENTS) {
    const row = deptById.get(d.id);
    console.log(`  ${d.name} — активных ${row?.active_cnt ?? '?'}, текущий режим ${row?.timesheet_export_mode ?? 'NULL (legacy)'}`);
  }
  console.log(`Сотрудники → current_activity (${TARGET_EMPLOYEES.length}):`);
  for (const e of TARGET_EMPLOYEES) {
    const row = empById.get(e.id);
    console.log(`  ${e.id} ${e.name} (${row?.dept_name ?? '?'}) — текущий режим ${row?.timesheet_export_mode ?? 'NULL (legacy)'}`);
  }

  if (problems.length > 0) {
    console.error('\n=== PREFLIGHT НЕ ПРОЙДЕН — ничего не записано ===');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\nPreflight пройден.');

  if (!apply) {
    console.log('Режим dry-run. Для применения: --apply --actor-user-id=<uuid>');
    process.exit(0);
  }

  // ── Применение ─────────────────────────────────────────────────────────────
  const deptIds = TARGET_DEPARTMENTS.map(d => d.id);
  const empIds = TARGET_EMPLOYEES.map(e => e.id);

  const snapshot = await withTransaction(async client => {
    // Порядок важен: лок → FOR UPDATE → снимок.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);

    const deptBefore = await client.query<{ id: string; timesheet_export_mode: string | null; timesheet_export_object_id: string | null }>(
      `SELECT id::text, timesheet_export_mode, timesheet_export_object_id::text
         FROM org_departments WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [deptIds],
    );
    const empBefore = await client.query<{ id: number; timesheet_export_mode: string | null; timesheet_export_object_id: string | null }>(
      `SELECT id, timesheet_export_mode, timesheet_export_object_id::text
         FROM employees WHERE id = ANY($1::int[]) FOR UPDATE`,
      [empIds],
    );

    // Повторная проверка под локом: между preflight и локом кто-то мог задать режим.
    const dirty = [
      ...deptBefore.rows.filter(r => r.timesheet_export_mode !== null).map(r => `отдел ${r.id}`),
      ...empBefore.rows.filter(r => r.timesheet_export_mode !== null).map(r => `сотрудник ${r.id}`),
    ];
    if (dirty.length > 0) {
      throw new Error(`Режим задан вручную между проверкой и записью: ${dirty.join(', ')}. Отмена.`);
    }

    const snap: ISnapshot = {
      created_at: new Date().toISOString(),
      departments: deptBefore.rows.map(r => ({ id: r.id, mode: r.timesheet_export_mode, object_id: r.timesheet_export_object_id })),
      employees: empBefore.rows.map(r => ({ id: Number(r.id), mode: r.timesheet_export_mode, object_id: r.timesheet_export_object_id })),
    };

    await client.query(
      `UPDATE org_departments SET timesheet_export_mode = 'skud', timesheet_export_object_id = NULL
        WHERE id = ANY($1::uuid[])`,
      [deptIds],
    );
    await client.query(
      `UPDATE employees SET timesheet_export_mode = 'current_activity', timesheet_export_object_id = NULL, updated_at = now()
        WHERE id = ANY($1::int[])`,
      [empIds],
    );

    await auditService.logWithClient(client, {
      user_id: actorUserId,
      action: AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED,
      entity_type: 'timesheet_export_mode',
      entity_id: 'itr-objects-setup',
      details: {
        source: 'set-timesheet-modes-itr',
        departments: TARGET_DEPARTMENTS.map(d => ({ id: d.id, name: d.name, old_mode: null, new_mode: 'skud' })),
        employees: TARGET_EMPLOYEES.map(e => ({ id: e.id, name: e.name, old_mode: null, new_mode: 'current_activity' })),
      },
    });

    return snap;
  });

  const snapshotPath = path.resolve(
    __dirname,
    `../../temp/rollback_timesheet_modes_${snapshot.created_at.replace(/[:.]/g, '-')}.json`,
  );
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`\nСнимок «до» сохранён: ${snapshotPath}`);

  // ── Post-check: изменились ровно ожидаемые строки ──────────────────────────
  const unexpectedDept = await query<{ id: string; name: string; timesheet_export_mode: string | null }>(
    `SELECT id::text, name, timesheet_export_mode FROM org_departments
      WHERE timesheet_export_mode IS NOT NULL AND NOT (id = ANY($1::uuid[]))`,
    [deptIds],
  );
  const unexpectedEmp = await query<{ id: number; full_name: string; timesheet_export_mode: string | null }>(
    `SELECT id, full_name, timesheet_export_mode FROM employees
      WHERE timesheet_export_mode IS NOT NULL AND NOT (id = ANY($1::int[]))`,
    [empIds],
  );
  const changedDept = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM org_departments WHERE id = ANY($1::uuid[]) AND timesheet_export_mode = 'skud'`,
    [deptIds],
  );
  const changedEmp = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM employees WHERE id = ANY($1::int[]) AND timesheet_export_mode = 'current_activity'`,
    [empIds],
  );

  console.log(`\nПрименено: отделов ${changedDept[0].cnt}/${deptIds.length}, сотрудников ${changedEmp[0].cnt}/${empIds.length}`);
  if (unexpectedDept.length > 0 || unexpectedEmp.length > 0) {
    console.warn('⚠ Есть строки с явным режимом ВНЕ целевого набора (заданы отдельно через UI — это нормально, если так и было):');
    for (const r of unexpectedDept) console.warn(`   отдел ${r.name} = ${r.timesheet_export_mode}`);
    for (const r of unexpectedEmp) console.warn(`   сотрудник ${r.full_name} = ${r.timesheet_export_mode}`);
  }

  console.log('\nГотово. Откат: --rollback ' + snapshotPath + ' --actor-user-id=<uuid>');
  process.exit(0);
}

async function runRollback(
  file: string,
  actorUserId: string,
  deps: {
    withTransaction: typeof import('../src/config/postgres.js').withTransaction;
    auditService: typeof import('../src/services/audit.service.js').auditService;
    AUDIT_ACTIONS: typeof import('../src/services/audit.service.js').AUDIT_ACTIONS;
    TIMESHEET_MODE_LOCK_KEY: number;
  },
): Promise<void> {
  const snapshot: ISnapshot = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  console.log(`Откат из снимка от ${snapshot.created_at}: отделов ${snapshot.departments.length}, сотрудников ${snapshot.employees.length}`);

  await deps.withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [deps.TIMESHEET_MODE_LOCK_KEY]);
    for (const d of snapshot.departments) {
      await client.query(
        'UPDATE org_departments SET timesheet_export_mode = $1, timesheet_export_object_id = $2::uuid WHERE id = $3::uuid',
        [d.mode, d.object_id, d.id],
      );
    }
    for (const e of snapshot.employees) {
      await client.query(
        'UPDATE employees SET timesheet_export_mode = $1, timesheet_export_object_id = $2::uuid, updated_at = now() WHERE id = $3::int',
        [e.mode, e.object_id, e.id],
      );
    }
    await deps.auditService.logWithClient(client, {
      user_id: actorUserId,
      action: deps.AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED,
      entity_type: 'timesheet_export_mode',
      entity_id: 'itr-objects-rollback',
      details: { source: 'set-timesheet-modes-itr --rollback', snapshot_created_at: snapshot.created_at },
    });
  });

  console.log('Откат применён.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
