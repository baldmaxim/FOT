/**
 * Список общежитий из 1С (xlsx «Список проживающих в общ. на 19.11.26», отчёт «Проживающие в общежитии последний вход
 * (СКД)») → SQL, после которого открытые проживания «Общежития» портала (вид dormitory без служебной квартиры) ровно
 * совпадают с файлом. Решения пользователя 19.11.2026 — в src/services/dormitory-sync-plan.ts (дата файла 2026-11-19,
 * принятые в ноябре — с даты приёма, уволенные — днём после увольнения, остальное — датой файла).
 *
 * Работает на read-only проде (роль mcp_readonly из --env-file, снимок REPEATABLE READ READ ONLY) и в базу ничего не
 * пишет. Сотрудник — по ФИО (ё = е, пробелы, регистр): ровно одна работающая карточка, иначе одна карточка вообще,
 * иначе стоп. В файле ровно --expect строк (246), иначе стоп. Результат — один SQL в --out (права 600, не в git — ФИО),
 * существующий файл не перезаписывается; в шапке — SHA-256 xlsx и сводка.
 *
 * SQL: \set ON_ERROR_STOP on, BEGIN, lock_timeout и idle_in_transaction_session_timeout (SET LOCAL), замки сотрудников
 * pg_advisory_xact_lock(hashtext('payroll_terms:'||id)) в порядке id (как lockPayrollEmployee), проверка исходного
 * состояния (каждая закрываемая и переселяемая запись открыта с ожидаемым адресом и въездом; у заселяемых нет записей
 * с выездом позже въезда), операции с аудитом DORMITORY_STAY_* (source import_2026_11_19), пост-проверки (по адресам —
 * как в файле; въезды прежних записей не изменились; новые въезды и выезды — не раньше 01.11). COMMIT нет — после
 * сверки вывода вручную COMMIT; или ROLLBACK;.
 *
 * Запуск:
 *   cd fot-server && TZ=UTC npx tsx scripts/build-dormitory-sync-sql.ts \
 *     --file "../temp/pz/ноябрь/Список проживающих в общ. на 19.11.26.xlsx" \
 *     --out "../temp/pz/ноябрь/dormitory-sync-2026-11-19.sql" [--expect 246] [--env-file ~/.config/mcp/env]
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import {
  planDormitorySync,
  type ISyncEmployee,
  type ISyncFileResident,
  type ISyncOpenStay,
  type SyncOperation,
} from '../src/services/dormitory-sync-plan.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Дата файла — константа: результат не зависит от дня запуска. */
const FILE_DATE = '2026-11-19';
const AUDIT_SOURCE = 'import_2026_11_19';

interface IArgs { file: string; out: string; expect: number; envFile: string }

const parseArgs = (argv: readonly string[]): IArgs => {
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  const file = value('--file');
  const out = value('--out');
  if (!file || !out) throw new Error('Нужны --file <xlsx> и --out <sql>');
  return {
    file: path.resolve(file),
    out: path.resolve(out),
    expect: Number(value('--expect') ?? '246'),
    envFile: value('--env-file') ?? path.join(os.homedir(), '.config', 'mcp', 'env'),
  };
};

/** Read-only роль прода — до импорта config/postgres: env.ts читает переменные при импорте. Значения не печатаются. */
const loadReadonlyEnv = (envFile: string): void => {
  const vars = new Map<string, string>();
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (match) vars.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const url = vars.get('FOT_MCP_PGURL');
  const password = vars.get('FOT_MCP_PGPASSWORD');
  if (!url || !password) throw new Error(`${envFile}: нет FOT_MCP_PGURL или FOT_MCP_PGPASSWORD`);
  process.env.DATABASE_URL = url;
  process.env.PGPASSWORD = password;
  process.env.DATABASE_SSL_CA_PATH = path.join(REPO, '.migration', 'yandex-ca.pem');
  process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX ?? '1';
  process.env.NODE_ENV = 'test';
};

/** Ключ ФИО: регистр, ё = е, пробелы. */
const nameKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const SQL_NAME_KEY = `translate(lower(regexp_replace(btrim(e.full_name), '\\s+', ' ', 'g')), 'ё', 'е')`;
const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const sqlDate = (value: string | null): string => (value === null ? 'NULL' : `DATE ${sqlText(value)}`);
const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'richText' in value) return value.richText.map(part => part.text).join('');
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '');
  return String(value);
};

interface IFileRow { address: string; department: string; fullName: string }

/** Строки файла: заголовок общежития (ФИО пусто) → его жители. */
const readFile = async (file: string): Promise<IFileRow[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const rows: IFileRow[] = [];
  let address: string | null = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 4) return;
    const department = cellText(row.getCell(2).value).trim();
    // Строка общежития — объединённые ячейки B:G: exceljs отдаёт значение объединения и в столбце «Сотрудник».
    const nameCell = row.getCell(3);
    const isGroup = nameCell.isMerged && nameCell.master.address !== nameCell.address;
    const fullName = isGroup ? '' : cellText(nameCell.value).replace(/\s+/g, ' ').trim();
    if (!fullName && department) { address = department; return; }
    if (!fullName) return;
    if (!address) throw new Error(`Строка ${rowNumber}: житель до первого общежития`);
    rows.push({ address, department, fullName });
  });
  return rows;
};

const operationSql = (operation: SyncOperation): string => {
  const audit = (action: string, idSql: string, details: string) => (
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       SELECT NULL, '${action}', 'employee_dormitory_stays', (${idSql})::text, ${details};`
  );
  if (operation.kind === 'add') {
    return `-- Заселить: ${operation.fullName} → ${operation.address} с ${operation.checkIn}
WITH added AS (
  INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address)
  VALUES (${operation.employeeId}, 'dormitory', ${sqlDate(operation.checkIn)}, NULL, ${sqlText(operation.address)})
  RETURNING id, employee_id, check_in, address
)
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
SELECT NULL, 'DORMITORY_STAY_ADDED', 'employee_dormitory_stays', added.id::text,
       jsonb_build_object('source', '${AUDIT_SOURCE}', 'employee_id', added.employee_id, 'full_name', ${sqlText(operation.fullName)},
                          'kind', 'dormitory', 'check_in', added.check_in, 'check_out', NULL, 'address', added.address)
  FROM added;
INSERT INTO dormitory_addresses (address) VALUES (${sqlText(operation.address)}) ON CONFLICT DO NOTHING;`;
  }
  if (operation.kind === 'move') {
    return `-- Переселить: ${operation.fullName} ${operation.from} → ${operation.to} с ${operation.date}
UPDATE employee_dormitory_stays SET check_out = ${sqlDate(operation.date)}, updated_at = now() WHERE id = ${operation.stayId};
WITH added AS (
  INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address)
  VALUES (${operation.employeeId}, 'dormitory', ${sqlDate(operation.date)}, ${sqlDate(operation.stayCheckOut)}, ${sqlText(operation.to)})
  RETURNING id, employee_id, check_in, check_out, address
)
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
SELECT NULL, 'DORMITORY_STAY_ADDED', 'employee_dormitory_stays', added.id::text,
       jsonb_build_object('source', '${AUDIT_SOURCE}', 'move_from_stay', ${operation.stayId}, 'employee_id', added.employee_id,
                          'full_name', ${sqlText(operation.fullName)}, 'kind', 'dormitory', 'check_in', added.check_in,
                          'check_out', added.check_out, 'address', added.address)
  FROM added;
${audit('DORMITORY_STAY_UPDATED', String(operation.stayId), `jsonb_build_object('source', '${AUDIT_SOURCE}', 'employee_id', ${operation.employeeId},
         'full_name', ${sqlText(operation.fullName)}, 'address', ${sqlText(operation.from)}, 'check_in', ${sqlText(operation.stayCheckIn)},
         'check_out', jsonb_build_object('from', ${operation.stayCheckOut === null ? 'NULL' : sqlText(operation.stayCheckOut)}, 'to', ${sqlText(operation.date)}))`)}
INSERT INTO dormitory_addresses (address) VALUES (${sqlText(operation.to)}) ON CONFLICT DO NOTHING;`;
  }
  return `-- Выселить (${operation.reason}): ${operation.fullName}, ${operation.address}, выезд ${operation.checkOut}
UPDATE employee_dormitory_stays SET check_out = ${sqlDate(operation.checkOut)}, updated_at = now() WHERE id = ${operation.stayId};
${audit('DORMITORY_STAY_UPDATED', String(operation.stayId), `jsonb_build_object('source', '${AUDIT_SOURCE}', 'reason', '${operation.reason}',
         'employee_id', ${operation.employeeId}, 'full_name', ${sqlText(operation.fullName)}, 'address', ${sqlText(operation.address)},
         'check_in', ${sqlText(operation.stayCheckIn)}, 'check_out', jsonb_build_object('from', NULL, 'to', ${sqlText(operation.checkOut)}))`)}`;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (fs.existsSync(args.out)) throw new Error(`Результат уже есть — не перезаписываю: ${args.out}`);
  const xlsx = fs.readFileSync(args.file);
  const fileHash = createHash('sha256').update(xlsx).digest('hex');
  const fileRows = await readFile(args.file);
  if (fileRows.length !== args.expect) throw new Error(`В файле ${fileRows.length} жителей, ожидалось ${args.expect}`);

  loadReadonlyEnv(args.envFile);
  const { query, closeDb, withReadOnlySnapshot } = await import('../src/config/postgres.js');
  try {
    const [role] = await query<{ who: string; can_write: boolean }>(
      `SELECT current_user AS who, has_table_privilege('public.employee_dormitory_stays', 'UPDATE') AS can_write`,
    );
    if (role?.who !== 'mcp_readonly' || role.can_write) {
      throw new Error(`Нужна read-only роль mcp_readonly без права записи, а подключено: ${role?.who ?? '?'}`);
    }

    const snapshot = await withReadOnlySnapshot(async client => {
      // До миграции 371 служебная квартира — общежитие с адресом «Кв. …»; SQL всё равно применяется только после 371.
      const has371 = (await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'employee_dormitory_stays' AND column_name = 'apartment_id'`,
      )).rows.length > 0;
      const dormitoryClass = has371
        ? `s.kind = 'dormitory' AND s.apartment_id IS NULL`
        : `s.kind = 'dormitory' AND s.address !~ '^\\s*[Кк][Вв][.\\s]'`;
      const keys = [...new Set(fileRows.map(row => nameKey(row.fullName)))];
      const employees = (await client.query<{
        id: number; full_name: string; key: string; employment_status: string | null; hire_date: string | null; dismissal_date: string | null;
      }>(
        `SELECT e.id, e.full_name, ${SQL_NAME_KEY} AS key, e.employment_status,
                to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date
           FROM employees e WHERE ${SQL_NAME_KEY} = ANY($1::text[])`,
        [keys],
      )).rows;
      const open = (await client.query<{
        id: number; employee_id: number; address: string; check_in: string; check_out: string | null;
        full_name: string; employment_status: string | null; hire_date: string | null; dismissal_date: string | null;
      }>(
        `SELECT s.id, s.employee_id, s.address, to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
                to_char(s.check_out, 'YYYY-MM-DD') AS check_out, e.full_name, e.employment_status,
                to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date
           FROM employee_dormitory_stays s JOIN employees e ON e.id = s.employee_id
          WHERE ${dormitoryClass}
            AND s.check_in <= $1::date AND (s.check_out IS NULL OR s.check_out > $1::date)`,
        [FILE_DATE],
      )).rows;
      // У заселяемых не должно быть никаких проживаний после даты въезда (служебная квартира, компенсация).
      const other = (await client.query<{ employee_id: number; kind: string; check_in: string; check_out: string | null }>(
        `SELECT s.employee_id, s.kind, to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
                to_char(s.check_out, 'YYYY-MM-DD') AS check_out
           FROM employee_dormitory_stays s
          WHERE NOT (${dormitoryClass}) AND (s.check_out IS NULL OR s.check_out > DATE '2026-11-01')`,
      )).rows;
      return { employees, open, other, has371 };
    });

    // ФИО → сотрудник: одна работающая карточка; нет работающих — единственная карточка; иначе стоп.
    const byKey = new Map<string, typeof snapshot.employees>();
    for (const employee of snapshot.employees) byKey.set(employee.key, [...(byKey.get(employee.key) ?? []), employee]);
    const problems: string[] = [];
    const residents: ISyncFileResident[] = [];
    const employees = new Map<number, ISyncEmployee>();
    for (const row of fileRows) {
      const cards = byKey.get(nameKey(row.fullName)) ?? [];
      const active = cards.filter(card => card.employment_status === 'active');
      const chosen = active.length === 1 ? active[0] : active.length === 0 && cards.length === 1 ? cards[0] : null;
      if (!chosen) {
        problems.push(`${row.fullName}: карточек ${cards.length}, работающих ${active.length}`);
        continue;
      }
      residents.push({ employeeId: chosen.id, fullName: row.fullName, address: row.address });
      employees.set(chosen.id, {
        id: chosen.id, fullName: chosen.full_name, employmentStatus: chosen.employment_status,
        hireDate: chosen.hire_date, dismissalDate: chosen.dismissal_date,
      });
    }
    if (problems.length > 0) throw new Error(`ФИО без однозначной карточки — стоп:\n  ${problems.join('\n  ')}`);
    for (const stay of snapshot.open) {
      if (!employees.has(stay.employee_id)) {
        employees.set(stay.employee_id, {
          id: stay.employee_id, fullName: stay.full_name, employmentStatus: stay.employment_status,
          hireDate: stay.hire_date, dismissalDate: stay.dismissal_date,
        });
      }
    }
    const openStays: ISyncOpenStay[] = snapshot.open.map(stay => ({
      id: stay.id, employeeId: stay.employee_id, address: stay.address, checkIn: stay.check_in, checkOut: stay.check_out,
    }));
    const plan = planDormitorySync(residents, employees, openStays, FILE_DATE);
    const adds = plan.operations.filter(operation => operation.kind === 'add');
    const conflicts = adds.filter(add => snapshot.other.some(stay => stay.employee_id === add.employeeId));
    if (conflicts.length > 0) {
      throw new Error(`У заселяемых есть квартира или компенсация после 01.11 — стоп:\n  ${conflicts.map(add => add.fullName).join('\n  ')}`);
    }

    const count = (kind: SyncOperation['kind']) => plan.operations.filter(operation => operation.kind === kind).length;
    const fileCounts = new Map<string, number>();
    for (const row of fileRows) fileCounts.set(row.address, (fileCounts.get(row.address) ?? 0) + 1);
    const employeeIds = [...new Set(plan.operations.map(operation => operation.employeeId))].sort((a, b) => a - b);
    const touchedStays = plan.operations.filter(operation => operation.kind !== 'add') as Array<Exclude<SyncOperation, { kind: 'add' }>>;
    const summary = [
      `Файл: ${path.basename(args.file)} — ${fileRows.length} жителей, SHA-256 ${fileHash}`,
      `Дата файла: ${FILE_DATE}. Совпадает: ${plan.same}. Заселить: ${count('add')}. Переселить: ${count('move')}. Выселить: ${count('close')}.`,
      ...[...fileCounts].map(([address, n]) => `  ${address}: ${n}`),
    ];

    const sql = `-- Общежития по файлу 1С на ${FILE_DATE} (scripts/build-dormitory-sync-sql.ts, ${new Date().toISOString()}).
${summary.map(line => `-- ${line}`).join('\n')}
-- Применять: psql … -f этот_файл (или \\i в интерактивном psql). COMMIT нет: сверить вывод, затем COMMIT; или ROLLBACK;.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '10min';

-- Только после миграции 371 (служебные квартиры отделены от общежитий).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'employee_dormitory_stays' AND column_name = 'apartment_id') THEN
    RAISE EXCEPTION 'Сначала миграция 371_company_apartments.sql';
  END IF;
END $$;

-- Замки сотрудников — как lockPayrollEmployee, в порядке id (без взаимных блокировок с записью из портала).
SELECT count(*) AS locked FROM (
  SELECT pg_advisory_xact_lock(hashtext('payroll_terms:' || id)) FROM unnest(ARRAY[${employeeIds.join(', ')}]::int[]) AS id ORDER BY id
) locks;

-- Исходное состояние: всё как при генерации, иначе — стоп.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(e.id::text, ', ') INTO bad
    FROM (VALUES ${touchedStays.map(op => `(${op.stayId}, ${op.employeeId}, ${sqlText(op.kind === 'move' ? op.from : op.address)}, ${sqlDate(op.stayCheckIn)})`).join(',\n           ') || '(0, 0, \'\', NULL::date)'}
    ) AS e(id, employee_id, address, check_in)
   WHERE e.id <> 0 AND NOT EXISTS (
     SELECT 1 FROM employee_dormitory_stays s
      WHERE s.id = e.id AND s.employee_id = e.employee_id AND s.kind = 'dormitory' AND s.apartment_id IS NULL
        AND s.address = e.address AND s.check_in = e.check_in
        AND (s.check_out IS NULL OR s.check_out > DATE '${FILE_DATE}'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Записи изменились после генерации: %', bad; END IF;

  SELECT string_agg(s.employee_id::text, ', ') INTO bad
    FROM (VALUES ${adds.map(op => `(${op.employeeId}, ${sqlDate(op.checkIn)})`).join(', ') || '(0, NULL::date)'}) AS a(employee_id, check_in)
    JOIN employee_dormitory_stays s ON s.employee_id = a.employee_id
   WHERE s.check_out IS NULL OR s.check_out > a.check_in;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'У заселяемых уже есть проживание: %', bad; END IF;

  -- Увольняемые в дату файла выселяются ею: в этот день у них не должно быть рабочего дня (иначе доплата 160 за 19.11).
  SELECT string_agg(c.employee_id::text, ', ') INTO bad
    FROM (VALUES ${plan.operations.filter(op => op.kind === 'close' && op.reason === 'dismissed_on_file_date').map(op => `(${op.employeeId})`).join(', ') || '(0)'}) AS c(employee_id)
   WHERE c.employee_id <> 0 AND (
     EXISTS (SELECT 1 FROM skud_events ev WHERE ev.employee_id = c.employee_id AND ev.event_date = DATE '${FILE_DATE}')
     OR EXISTS (SELECT 1 FROM attendance_adjustments a WHERE a.employee_id = c.employee_id AND a.work_date = DATE '${FILE_DATE}'
                  AND a.status IS DISTINCT FROM 'unpaid'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'У увольняемых в дату файла есть проход или не «без сохранения»: %', bad; END IF;
END $$;

${plan.operations.map(operationSql).join('\n\n')}

-- Пост-проверки.
DO $$
DECLARE bad TEXT;
BEGIN
  -- Живут на дату файла и открыты (без выезда) — по адресам ровно как в файле.
  SELECT string_agg(coalesce(f.address, o.address) || ': файл ' || coalesce(f.n, 0) || ', портал ' || coalesce(o.n, 0), '; ') INTO bad
    FROM (VALUES ${[...fileCounts].map(([address, n]) => `(${sqlText(address)}, ${n})`).join(', ')}) AS f(address, n)
    FULL JOIN (
      SELECT address, count(*) AS n FROM employee_dormitory_stays
       WHERE kind = 'dormitory' AND apartment_id IS NULL AND check_in <= DATE '${FILE_DATE}'
         AND (check_out IS NULL OR check_out > DATE '${FILE_DATE}')
       GROUP BY address
    ) o ON lower(o.address) = lower(f.address)
   WHERE coalesce(f.n, 0) <> coalesce(o.n, 0);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Не сошлось с файлом: %', bad; END IF;

  SELECT string_agg(address, '; ') INTO bad FROM (
    SELECT lower(address) AS address FROM employee_dormitory_stays
     WHERE kind = 'dormitory' AND apartment_id IS NULL AND check_out IS NULL GROUP BY lower(address)
    EXCEPT SELECT lower(unnest(ARRAY[${[...fileCounts.keys()].map(sqlText).join(', ')}]))
  ) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Открытые проживания вне файла: %', bad; END IF;

  -- Сентябрь–октябрь: въезды тронутых записей прежние, новые въезды и выезды — не раньше 01.11.
  SELECT string_agg(e.id::text, ', ') INTO bad
    FROM (VALUES ${touchedStays.map(op => `(${op.stayId}, ${sqlDate(op.stayCheckIn)})`).join(', ') || '(0, NULL::date)'}) AS e(id, check_in)
    JOIN employee_dormitory_stays s ON s.id = e.id
   WHERE s.check_in <> e.check_in OR s.check_out < DATE '2026-11-01';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Тронуты даты до 01.11: %', bad; END IF;

  SELECT string_agg(s.id::text, ', ') INTO bad
    FROM employee_dormitory_stays s
   WHERE s.employee_id = ANY(ARRAY[${employeeIds.join(', ')}]::int[])
     AND s.created_at = now()
     AND s.check_in < DATE '2026-11-01';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Новые записи раньше 01.11: %', bad; END IF;
END $$;

SELECT address, count(*) AS residents FROM employee_dormitory_stays
 WHERE kind = 'dormitory' AND apartment_id IS NULL AND check_out IS NULL GROUP BY address ORDER BY address;
\\echo 'Проверки пройдены. Сверьте вывод и наберите COMMIT; (или ROLLBACK;).'
`;
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, sql, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(args.out, 0o600);
    if (!snapshot.has371) console.log('Снимок прода — до миграции 371: применять после 371, перед применением лучше перегенерировать.');
    console.log(summary.join('\n'));
    console.log(`\nSQL: ${args.out}`);
    for (const operation of plan.operations) {
      const line = operation.kind === 'add'
        ? `+ ${operation.fullName} → ${operation.address} с ${operation.checkIn}`
        : operation.kind === 'move'
          ? `↔ ${operation.fullName}: ${operation.from} → ${operation.to} с ${operation.date}`
          : `− ${operation.fullName}: ${operation.address}, выезд ${operation.checkOut} (${operation.reason})`;
      console.log(line);
    }
  } finally {
    await closeDb();
  }
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
