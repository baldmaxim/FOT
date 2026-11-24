/**
 * Журналы общежитий 1С (папка temp/pz/проживание: «<общежитие> заезд.xlsx» — журнал заездов и «Проживают на данный
 * момент», «<общежитие> выбытие.xlsx» — журнал выездов) → SQL, после которого «Общежитие» портала с --from (01.11)
 * совпадает с 1С, а въезд-заглушка 01.09 заменён настоящим заездом. Правила — src/services/dormitory-journal-sync-plan.ts
 * (решения пользователя 24.11.2026). Плюс сверка для кадров: один лист по людям — что правим и что нет.
 *
 * Читает прод под read-only ролью mcp_readonly (--env-file, снимок REPEATABLE READ READ ONLY) или тестовую базу (--db),
 * сам ничего не пишет. План проверяется повтором на итоговых записях (должен быть пустым).
 * SQL: \set ON_ERROR_STOP on, BEGIN, lock_timeout, idle_in_transaction_session_timeout, замки payroll_terms:<id>,
 * проверка «записи не менялись после генерации», сначала сокращения и удаления, потом удлинения и вставки (EXCLUDE),
 * аудит DORMITORY_STAY_* (source import_1c_journal_<дата>), пост-проверки (сентябрь–октябрь по дням прежние, итоговые
 * даты как в плане, открытые на день выгрузки — как «Проживают»). COMMIT нет: сверить вывод, затем COMMIT; или ROLLBACK;.
 * Файлы результата — права 600, существующие не перезаписываются (ФИО, не в git).
 *
 * Запуск:
 *   cd fot-server && TZ=UTC npx tsx scripts/build-dormitory-journal-sync-sql.ts \
 *     --dir ../temp/pz/проживание --file-date 2026-11-24 \
 *     --out ../temp/pz/ноябрь/dormitory-journal-sync-2026-11-24.sql \
 *     --xlsx ../temp/pz/ноябрь/Общежития_1С_ФОТ_2026-11-24.xlsx \
 *     [--from 2026-11-01] [--real-check-in-before 2026-09-01] [--env-file ~/.config/mcp/env | --db postgresql://…]
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import {
  applyJournalOperations,
  journalNameKey,
  planDormitoryJournalSync,
  ruDate,
  type IDormitoryJournal,
  type IJournalCard,
  type IJournalEntry,
  type IJournalNote,
  type IJournalStay,
  type IJournalSyncOptions,
  type JournalSyncOperation,
} from '../src/services/dormitory-journal-sync-plan.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Имя файла без «заезд/выбытие» (регистр, ё, пробелы не важны) → название в справочнике общежитий. */
const DORMITORY_FILES: Readonly<Record<string, string>> = {
  'база мытищи': 'Общ. База Мытищи',
  'база химки': 'Общ. База Химки',
  'боровское ш 12а': 'Общ. Боровское ш. 12А',
  'верхнелихоборская 6': 'Общ. Верхнелихоборская 6',
  'верхнелихобоская 6': 'Общ. Верхнелихоборская 6', // опечатка в имени файла заезда 24.11.2026
  'мал.почтовая 2': 'Общ. Мал.Почтовая 2\\2',
  'нагатинская 34': 'Общ. Нагатинская 34',
  'свободы 35': 'Общ. Свободы 35',
};
const RESIDENTS_MARKER = 'проживают на данный момент';

interface IArgs {
  dir: string;
  out: string;
  xlsx: string;
  options: IJournalSyncOptions;
  envFile: string;
  db: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const parseArgs = (argv: readonly string[]): IArgs => {
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  const dir = value('--dir');
  const out = value('--out');
  const xlsx = value('--xlsx');
  const fileDate = value('--file-date');
  if (!dir || !out || !xlsx || !fileDate) throw new Error('Нужны --dir <папка>, --file-date <ГГГГ-ММ-ДД>, --out <sql> и --xlsx <сверка>');
  const from = value('--from') ?? `${fileDate.slice(0, 7)}-01`;
  const realCheckInBefore = value('--real-check-in-before') ?? '2026-09-01';
  for (const date of [fileDate, from, realCheckInBefore]) if (!ISO.test(date)) throw new Error(`Дата не ГГГГ-ММ-ДД: ${date}`);
  return {
    dir: path.resolve(dir),
    out: path.resolve(out),
    xlsx: path.resolve(xlsx),
    options: { fileDate, from, realCheckInBefore },
    envFile: value('--env-file') ?? path.join(os.homedir(), '.config', 'mcp', 'env'),
    db: value('--db'),
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
  process.env.DATABASE_POOL_MAX = '1';
  process.env.NODE_ENV = 'test';
  process.env.PGOPTIONS = '-c default_transaction_read_only=on';
};

const fileKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'richText' in value) return value.richText.map(part => part.text).join('');
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '');
  return String(value);
};
const cellDate = (value: ExcelJS.CellValue): string | null => (
  value instanceof Date ? `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}` : null
);

interface IReadJournal { journal: IDormitoryJournal; files: Array<{ name: string; sha256: string; rows: number }> }

/** Файл: строка 1 — «N | Дата заезда/выезда | Сотрудник | Бригада», журнал, затем (в заезде) «Проживают на данный момент». */
const readFile = async (file: string, kind: 'in' | 'out'): Promise<{ entries: IJournalEntry[]; residents: string[] | null }> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  const header = [1, 2, 3].map(column => fileKey(cellText(sheet.getRow(1).getCell(column).value)));
  const expected = ['n', kind === 'in' ? 'дата заезда' : 'дата выезда', 'сотрудник'];
  if (header.join('|') !== expected.join('|')) throw new Error(`${path.basename(file)}: шапка «${header.join(' | ')}», ожидалась «${expected.join(' | ')}»`);
  const entries: IJournalEntry[] = [];
  let residents: string[] | null = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const fullName = cellText(row.getCell(3).value).replace(/\s+/g, ' ').trim();
    const dateCell = row.getCell(2).value;
    if (!fullName && !cellText(dateCell)) return;
    if (fileKey(fullName) === RESIDENTS_MARKER) {
      if (kind !== 'in' || residents !== null) throw new Error(`${path.basename(file)}: строка ${rowNumber} — лишний «Проживают на данный момент»`);
      residents = [];
      return;
    }
    if (!fullName) throw new Error(`${path.basename(file)}: строка ${rowNumber} без ФИО`);
    if (residents !== null) {
      if (cellText(dateCell)) throw new Error(`${path.basename(file)}: строка ${rowNumber} — в «Проживают» есть дата`);
      residents.push(fullName);
      return;
    }
    const date = cellDate(dateCell);
    if (!date) throw new Error(`${path.basename(file)}: строка ${rowNumber} — дата не распознана: «${cellText(dateCell)}»`);
    entries.push({ date, fullName });
  });
  if (kind === 'in' && residents === null) throw new Error(`${path.basename(file)}: нет «Проживают на данный момент»`);
  return { entries, residents };
};

const readJournals = async (dir: string, fileDate: string): Promise<IReadJournal[]> => {
  const byDormitory = new Map<string, IReadJournal>();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.xlsx') || name.startsWith('~$')) continue;
    const match = /^(.*?)\s+(заезд|выбытие)$/.exec(fileKey(name.replace(/\.xlsx$/i, '')));
    const dormitory = match ? DORMITORY_FILES[match[1]] : undefined;
    if (!match || !dormitory) throw new Error(`Не знаю, какое это общежитие: ${name} — допишите DORMITORY_FILES`);
    const kind = match[2] === 'заезд' ? 'in' : 'out';
    const file = path.join(dir, name);
    const { entries, residents } = await readFile(file, kind);
    const late = entries.find(entry => entry.date > fileDate);
    if (late) throw new Error(`${name}: дата ${late.date} позже дня выгрузки ${fileDate}`);
    const read = byDormitory.get(dormitory) ?? { journal: { dormitory, checkIns: null, checkOuts: [], residents: null }, files: [] };
    byDormitory.set(dormitory, read);
    if (kind === 'in') {
      if (read.journal.checkIns !== null) throw new Error(`${dormitory}: два файла заезда`);
      read.journal.checkIns = entries;
      read.journal.residents = residents;
    } else {
      if (read.files.some(f => f.name.includes('выбытие'))) throw new Error(`${dormitory}: два файла выбытия`);
      read.journal.checkOuts = entries;
    }
    read.files.push({ name, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), rows: entries.length + (residents?.length ?? 0) });
  }
  for (const read of byDormitory.values()) {
    if (!read.files.some(f => f.name.includes('выбытие'))) throw new Error(`${read.journal.dormitory}: нет файла выбытия`);
  }
  return [...byDormitory.values()];
};

const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const sqlDate = (value: string | null): string => (value === null ? 'NULL::date' : `DATE ${sqlText(value)}`);
const sqlJsonDate = (value: string | null): string => (value === null ? `'null'::jsonb` : `to_jsonb(${sqlText(value)}::text)`);
const range = (checkIn: string, checkOut: string | null): string => `${ruDate(checkIn)} – ${checkOut === null ? 'живёт' : ruDate(checkOut)}`;
const maxDate = (a: string, b: string): string => (a > b ? a : b);
const minOut = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

interface ISnapshotStay extends IJournalStay { updatedAt: string }

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const { fileDate, from, realCheckInBefore } = args.options;
  for (const file of [args.out, args.xlsx]) if (fs.existsSync(file)) throw new Error(`Результат уже есть — не перезаписываю: ${file}`);
  const read = await readJournals(args.dir, fileDate);
  const journals = read.map(item => item.journal);
  const auditSource = `import_1c_journal_${fileDate.replace(/-/g, '_')}`;

  if (args.db) {
    process.env.DATABASE_URL = args.db;
    process.env.DATABASE_SSL = 'false';
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_POOL_MAX = '1';
  } else {
    loadReadonlyEnv(args.envFile);
  }
  const { query, closeDb, withReadOnlySnapshot } = await import('../src/config/postgres.js');
  try {
    const [role] = await query<{ who: string; can_write: boolean }>(
      `SELECT current_user AS who, has_table_privilege('public.employee_dormitory_stays', 'UPDATE') AS can_write`,
    );
    if (!args.db && (role?.who !== 'mcp_readonly' || role.can_write)) {
      throw new Error(`Нужна read-only роль mcp_readonly без права записи, а подключено: ${role?.who ?? '?'}`);
    }

    const keys = [...new Set(journals.flatMap(journal => [
      ...(journal.checkIns ?? []).map(entry => entry.fullName), ...journal.checkOuts.map(entry => entry.fullName), ...(journal.residents ?? []),
    ]).map(journalNameKey))];
    const NAME_KEY = `translate(lower(regexp_replace(btrim(e.full_name), '\\s+', ' ', 'g')), 'ё', 'е')`;
    const snapshot = await withReadOnlySnapshot(async client => {
      const cards = (await client.query<{
        id: number; full_name: string; employment_status: string | null; hire_date: string | null; dismissal_date: string | null;
      }>(
        `WITH k AS (
           SELECT unnest($1::text[]) AS key
           UNION
           SELECT ${NAME_KEY} FROM employees e
            WHERE e.id IN (SELECT employee_id FROM employee_dormitory_stays WHERE kind = 'dormitory' AND apartment_id IS NULL)
         )
         SELECT e.id, e.full_name, e.employment_status,
                to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date
           FROM employees e WHERE ${NAME_KEY} IN (SELECT key FROM k)`,
        [keys],
      )).rows;
      const stays = (await client.query<{
        id: number; employee_id: number; kind: string; apartment_id: number | null; address: string | null;
        check_in: string; check_out: string | null; updated_at: string;
      }>(
        `SELECT id, employee_id, kind, apartment_id, address, to_char(check_in, 'YYYY-MM-DD') AS check_in,
                to_char(check_out, 'YYYY-MM-DD') AS check_out,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at
           FROM employee_dormitory_stays WHERE employee_id = ANY($1::int[]) ORDER BY id`,
        [cards.map(card => card.id)],
      )).rows;
      const directory = (await client.query<{ address: string }>(`SELECT address FROM dormitory_addresses`)).rows.map(row => row.address);
      return { cards, stays, directory };
    });

    const missing = journals.map(journal => journal.dormitory).filter(name => !snapshot.directory.includes(name));
    if (missing.length > 0) throw new Error(`Нет в справочнике общежитий: ${missing.join(', ')}`);
    const cards: IJournalCard[] = snapshot.cards.map(card => ({
      id: card.id, fullName: card.full_name, employmentStatus: card.employment_status, hireDate: card.hire_date, dismissalDate: card.dismissal_date,
    }));
    const stays: ISnapshotStay[] = snapshot.stays.map(stay => ({
      id: stay.id, employeeId: stay.employee_id, kind: stay.kind, apartmentId: stay.apartment_id, address: stay.address,
      checkIn: stay.check_in, checkOut: stay.check_out, updatedAt: stay.updated_at,
    }));

    const plan = planDormitoryJournalSync(journals, cards, stays, args.options);
    const again = planDormitoryJournalSync(journals, cards, applyJournalOperations(stays, plan.operations), args.options);
    if (again.operations.length > 0) {
      throw new Error(`Повтор плана на итоговых записях не пустой (${again.operations.length}) — план неидемпотентен, стоп`);
    }

    const cardById = new Map(cards.map(card => [card.id, card]));
    const nameOf = (employeeId: number): string => {
      const card = cardById.get(employeeId);
      if (!card) return String(employeeId);
      return card.employmentStatus === 'fired' ? `${card.fullName} (уволен${card.dismissalDate ? ` ${ruDate(card.dismissalDate)}` : ''})` : card.fullName;
    };
    const ops = plan.operations;
    const updates = ops.filter((op): op is Extract<JournalSyncOperation, { kind: 'update' }> => op.kind === 'update');
    const adds = ops.filter((op): op is Extract<JournalSyncOperation, { kind: 'add' }> => op.kind === 'add');
    const deletes = ops.filter((op): op is Extract<JournalSyncOperation, { kind: 'delete' }> => op.kind === 'delete');
    const employeeIds = [...new Set(ops.map(op => op.employeeId))].sort((a, b) => a - b);

    // Сначала сократить (пересечение прежнего и нового периода), потом удлинить: EXCLUDE не мешает переставлять записи.
    const shrink = updates.map(op => ({
      op,
      mid: { checkIn: maxDate(op.before.checkIn, op.after.checkIn), checkOut: minOut(op.before.checkOut, op.after.checkOut) },
    }));
    for (const { op, mid } of shrink) {
      if (mid.checkOut !== null && mid.checkOut <= mid.checkIn) throw new Error(`Запись ${op.stayId}: прежний и новый период не пересекаются`);
    }

    const counts = {
      checkInReal: updates.filter(op => op.after.checkIn < op.before.checkIn && op.before.checkIn === realCheckInBefore).length,
      november: updates.filter(op => op.after.checkOut !== op.before.checkOut || (op.after.checkIn !== op.before.checkIn && op.before.checkIn >= from)).length,
    };
    const fileLines = read.flatMap(item => item.files.map(f => `  ${f.name}: строк ${f.rows}, SHA-256 ${f.sha256}`));
    const summary = [
      `Журналы 1С: ${args.dir} (день выгрузки ${fileDate}); с ${from} — как в 1С, въезд ${realCheckInBefore} → настоящий заезд.`,
      ...fileLines,
      `Изменить записей: ${updates.length} (въезд → настоящий заезд: ${counts.checkInReal}; даты с ${from}: ${counts.november}). Заселить: ${adds.length}. Удалить: ${deletes.length}.`,
      `«Проживают» на ${fileDate}: ${[...plan.residents].map(([name, n]) => `${name} ${n}`).join(', ')}.`,
    ];

    const audit = (action: string, idSql: string, details: string): string => (
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (NULL, '${action}', 'employee_dormitory_stays', (${idSql})::text, ${details});`
    );
    const updateSql = (stayId: number, next: { checkIn: string; checkOut: string | null }): string => (
      `UPDATE employee_dormitory_stays SET check_in = ${sqlDate(next.checkIn)}, check_out = ${sqlDate(next.checkOut)}, updated_at = now() WHERE id = ${stayId};`
    );
    const comment = (text: string): string => `-- ${text.replace(/\r?\n/g, ' ')}`;

    const phase1 = [
      ...deletes.map(op => [
        comment(`Удалить: ${nameOf(op.employeeId)}, ${op.address}, ${range(op.checkIn, op.checkOut)} — ${op.why}`),
        `DELETE FROM employee_dormitory_stays WHERE id = ${op.stayId};`,
        audit('DORMITORY_STAY_DELETED', String(op.stayId), `jsonb_build_object('source', '${auditSource}', 'employee_id', ${op.employeeId},
         'full_name', ${sqlText(cardById.get(op.employeeId)?.fullName ?? '')}, 'kind', 'dormitory', 'address', ${sqlText(op.address)},
         'check_in', ${sqlJsonDate(op.checkIn)}, 'check_out', ${sqlJsonDate(op.checkOut)}, 'why', ${sqlText(op.why)})`),
      ].join('\n')),
      ...shrink.filter(({ op, mid }) => mid.checkIn !== op.before.checkIn || mid.checkOut !== op.before.checkOut)
        .map(({ op, mid }) => `${comment(`Сократить: ${nameOf(op.employeeId)}, ${op.address} → ${range(mid.checkIn, mid.checkOut)}`)}\n${updateSql(op.stayId, mid)}`),
    ];
    const phase2 = shrink.filter(({ op, mid }) => mid.checkIn !== op.after.checkIn || mid.checkOut !== op.after.checkOut)
      .map(({ op }) => `${comment(`Удлинить: ${nameOf(op.employeeId)}, ${op.address} → ${range(op.after.checkIn, op.after.checkOut)}`)}\n${updateSql(op.stayId, op.after)}`);
    const updateAudits = updates.map(op => [
      comment(`${nameOf(op.employeeId)}, ${op.address}: ${range(op.before.checkIn, op.before.checkOut)} → ${range(op.after.checkIn, op.after.checkOut)} — ${op.why.join('; ')}`),
      audit('DORMITORY_STAY_UPDATED', String(op.stayId), `jsonb_build_object('source', '${auditSource}', 'employee_id', ${op.employeeId},
         'full_name', ${sqlText(cardById.get(op.employeeId)?.fullName ?? '')}, 'address', ${sqlText(op.address)},
         'check_in', jsonb_build_object('from', ${sqlJsonDate(op.before.checkIn)}, 'to', ${sqlJsonDate(op.after.checkIn)}),
         'check_out', jsonb_build_object('from', ${sqlJsonDate(op.before.checkOut)}, 'to', ${sqlJsonDate(op.after.checkOut)}),
         'why', ${sqlText(op.why.join('; '))})`),
    ].join('\n'));
    const phase3 = adds.map(op => `${comment(`Заселить: ${nameOf(op.employeeId)} → ${op.address}, ${range(op.checkIn, op.checkOut)} — ${op.why}`)}
WITH added AS (
  INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address)
  VALUES (${op.employeeId}, 'dormitory', ${sqlDate(op.checkIn)}, ${sqlDate(op.checkOut)}, ${sqlText(op.address)})
  RETURNING id
)
INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
SELECT NULL, 'DORMITORY_STAY_ADDED', 'employee_dormitory_stays', added.id::text,
       jsonb_build_object('source', '${auditSource}', 'employee_id', ${op.employeeId}, 'full_name', ${sqlText(cardById.get(op.employeeId)?.fullName ?? '')},
                          'kind', 'dormitory', 'address', ${sqlText(op.address)}, 'check_in', ${sqlJsonDate(op.checkIn)},
                          'check_out', ${sqlJsonDate(op.checkOut)}, 'why', ${sqlText(op.why)})
  FROM added;`);

    const touched = stays.filter(stay => employeeIds.includes(stay.employeeId));
    const ids = employeeIds.length > 0 ? employeeIds.join(', ') : '0';
    const expectedRows = touched.map(stay => `(${stay.id}, ${stay.employeeId}, ${sqlText(stay.kind)}, ${stay.apartmentId ?? 'NULL::int'}, ${stay.address === null ? 'NULL::text' : sqlText(stay.address)}, ${sqlDate(stay.checkIn)}, ${sqlDate(stay.checkOut)}, TIMESTAMPTZ ${sqlText(`${stay.updatedAt}+00`)})`);
    const fullNames = journals.filter(journal => journal.residents !== null).map(journal => journal.dormitory);
    const finalRows = applyJournalOperations(stays, ops).filter(stay => employeeIds.includes(stay.employeeId));

    const sql = `-- Общежития по журналам 1С (scripts/build-dormitory-journal-sync-sql.ts, ${new Date().toISOString()}).
${summary.map(line => `-- ${line}`).join('\n')}
-- Применять: psql -X -v ON_ERROR_STOP=1 … → \\i этот_файл → сверить вывод → COMMIT; (или ROLLBACK;). COMMIT в файле нет.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '5min';

-- Общежития — как в справочнике.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO bad
    FROM unnest(ARRAY[${journals.map(journal => sqlText(journal.dormitory)).join(', ')}]::text[]) AS name
   WHERE NOT EXISTS (SELECT 1 FROM dormitory_addresses a WHERE a.address = name);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Нет в справочнике общежитий: %', bad; END IF;
END $$;

-- Замки сотрудников — как lockPayrollEmployee, по порядку id.
SELECT count(*) AS locked FROM (
  SELECT pg_advisory_xact_lock(hashtext('payroll_terms:' || id)) FROM unnest(ARRAY[${ids}]::int[]) AS id ORDER BY id
) locks;

-- Исходное состояние: все проживания затронутых сотрудников — как при генерации (вкладку правят руками), иначе — стоп.
DO $$
DECLARE bad TEXT;
BEGIN
  WITH expected(id, employee_id, kind, apartment_id, address, check_in, check_out, updated_at) AS (
    VALUES ${expectedRows.join(',\n           ') || '(0, 0, \'\', NULL::int, NULL::text, NULL::date, NULL::date, NULL::timestamptz)'}
  ), actual AS (
    SELECT id, employee_id, kind, apartment_id, address, check_in, check_out, updated_at
      FROM employee_dormitory_stays WHERE employee_id = ANY(ARRAY[${ids}]::int[])
  )
  SELECT string_agg(coalesce(a.id, e.id)::text, ', ') INTO bad
    FROM (SELECT * FROM expected WHERE id <> 0) e FULL JOIN actual a ON a.id = e.id
   WHERE a.id IS NULL OR e.id IS NULL
      OR (a.employee_id, a.kind, a.apartment_id, a.address, a.check_in, a.check_out, a.updated_at)
         IS DISTINCT FROM (e.employee_id, e.kind, e.apartment_id, e.address, e.check_in, e.check_out, e.updated_at);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Проживания изменились после генерации (перегенерируйте SQL): %', bad; END IF;
END $$;

-- Дни ${realCheckInBefore} … ${from} (не включая) до правки — после правки должны остаться теми же.
CREATE TEMP TABLE journal_sync_before ON COMMIT DROP AS
SELECT s.employee_id, d::date AS day, s.kind, s.apartment_id, s.address
  FROM employee_dormitory_stays s
  CROSS JOIN LATERAL generate_series(greatest(s.check_in, DATE '${realCheckInBefore}'),
                                     least(coalesce(s.check_out, DATE '${from}'), DATE '${from}') - 1, interval '1 day') d
 WHERE s.employee_id = ANY(ARRAY[${ids}]::int[]);

-- Итог по затронутым сотрудникам, как в плане (для пост-проверки).
CREATE TEMP TABLE journal_sync_expected ON COMMIT DROP AS
SELECT * FROM (VALUES ${finalRows.map(stay => `(${stay.employeeId}, ${sqlText(stay.kind)}, ${stay.apartmentId ?? 'NULL::int'}, ${stay.address === null ? 'NULL::text' : sqlText(stay.address)}, ${sqlDate(stay.checkIn)}, ${sqlDate(stay.checkOut)})`).join(',\n  ') || '(0, \'\', NULL::int, NULL::text, NULL::date, NULL::date)'}
) AS f(employee_id, kind, apartment_id, address, check_in, check_out) WHERE employee_id <> 0;

-- 1. Удаления и сокращения.
${phase1.join('\n\n') || '-- нет'}

-- 2. Удлинения.
${phase2.join('\n\n') || '-- нет'}

-- Аудит изменённых записей.
${updateAudits.join('\n\n') || '-- нет'}

-- 3. Заселения.
${phase3.join('\n\n') || '-- нет'}

-- Пост-проверки.
DO $$
DECLARE bad TEXT;
BEGIN
  -- Дни до ${from} — прежние.
  SELECT string_agg(DISTINCT x.employee_id::text, ', ') INTO bad FROM (
    (SELECT * FROM journal_sync_before
     EXCEPT
     SELECT s.employee_id, d::date, s.kind, s.apartment_id, s.address
       FROM employee_dormitory_stays s
       CROSS JOIN LATERAL generate_series(greatest(s.check_in, DATE '${realCheckInBefore}'),
                                          least(coalesce(s.check_out, DATE '${from}'), DATE '${from}') - 1, interval '1 day') d
      WHERE s.employee_id = ANY(ARRAY[${ids}]::int[]))
    UNION ALL
    (SELECT s.employee_id, d::date, s.kind, s.apartment_id, s.address
       FROM employee_dormitory_stays s
       CROSS JOIN LATERAL generate_series(greatest(s.check_in, DATE '${realCheckInBefore}'),
                                          least(coalesce(s.check_out, DATE '${from}'), DATE '${from}') - 1, interval '1 day') d
      WHERE s.employee_id = ANY(ARRAY[${ids}]::int[])
     EXCEPT
     SELECT * FROM journal_sync_before)
  ) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Изменились дни до ${from}: %', bad; END IF;

  -- Итог по затронутым сотрудникам — ровно как в плане.
  SELECT string_agg(DISTINCT x.employee_id::text, ', ') INTO bad FROM (
    (SELECT * FROM journal_sync_expected
     EXCEPT ALL
     SELECT employee_id, kind, apartment_id, address, check_in, check_out FROM employee_dormitory_stays
      WHERE employee_id = ANY(ARRAY[${ids}]::int[]))
    UNION ALL
    (SELECT employee_id, kind, apartment_id, address, check_in, check_out FROM employee_dormitory_stays
      WHERE employee_id = ANY(ARRAY[${ids}]::int[])
     EXCEPT ALL
     SELECT * FROM journal_sync_expected)
  ) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Итог не совпал с планом у сотрудников: %', bad; END IF;

  -- Живут на ${fileDate} — по общежитиям столько же, сколько в «Проживают».
  SELECT string_agg(f.address || ': 1С ' || f.n || ', портал ' || coalesce(o.n, 0), '; ') INTO bad
    FROM (VALUES ${[...plan.residents].map(([name, n]) => `(${sqlText(name)}, ${n})`).join(', ')}) AS f(address, n)
    LEFT JOIN (
      SELECT lower(address) AS address, count(*) AS n FROM employee_dormitory_stays
       WHERE kind = 'dormitory' AND apartment_id IS NULL AND check_in <= DATE '${fileDate}'
         AND (check_out IS NULL OR check_out > DATE '${fileDate}')
       GROUP BY lower(address)
    ) o ON o.address = lower(f.address)
   WHERE coalesce(o.n, 0) <> f.n;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Не сошлось с «Проживают»: %', bad; END IF;
END $$;

SELECT address, count(*) FILTER (WHERE check_in <= DATE '${fileDate}' AND (check_out IS NULL OR check_out > DATE '${fileDate}')) AS live_${fileDate.replace(/-/g, '_')},
       count(*) FILTER (WHERE check_in <= DATE '${fileDate}' AND (check_out IS NULL OR check_out > DATE '${from}')) AS in_month
  FROM employee_dormitory_stays
 WHERE kind = 'dormitory' AND apartment_id IS NULL AND lower(address) = ANY(ARRAY[${fullNames.map(name => sqlText(name.toLowerCase())).join(', ')}]::text[])
 GROUP BY address ORDER BY address;
\\echo 'Проверки пройдены. Сверьте вывод и наберите COMMIT; (или ROLLBACK;).'
`;

    // Сверка для кадров: один лист по людям, только различия, словами.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Сверка');
    sheet.columns = [
      { header: '№', width: 6 }, { header: 'Сотрудник', width: 42 }, { header: 'Общежитие', width: 26 },
      { header: 'Что делаем', width: 18 }, { header: 'Было', width: 26 }, { header: 'Стало', width: 26 }, { header: 'Почему', width: 70 },
    ];
    type Row = { person: string; employeeId: number | null; dormitory: string; action: string; was: string; now: string; why: string; fill: string | null };
    const rows: Row[] = [
      ...updates.map(op => ({
        person: nameOf(op.employeeId), employeeId: op.employeeId, dormitory: op.address, action: 'Изменить даты',
        was: range(op.before.checkIn, op.before.checkOut), now: range(op.after.checkIn, op.after.checkOut), why: op.why.join('; '), fill: null,
      })),
      ...adds.map(op => ({
        person: nameOf(op.employeeId), employeeId: op.employeeId, dormitory: op.address, action: 'Заселить',
        was: '—', now: range(op.checkIn, op.checkOut), why: op.why, fill: 'FFE2F0D9',
      })),
      ...deletes.map(op => ({
        person: nameOf(op.employeeId), employeeId: op.employeeId, dormitory: op.address, action: 'Удалить запись',
        was: range(op.checkIn, op.checkOut), now: '—', why: op.why, fill: 'FFFCE4D6',
      })),
      ...plan.notes.map((note: IJournalNote) => ({
        person: note.employeeId !== null ? nameOf(note.employeeId) : note.fullName, employeeId: note.employeeId,
        dormitory: note.dormitory ?? '', action: 'Не правим', was: '', now: '', why: note.text, fill: 'FFF2F2F2',
      })),
    ];
    const order = (row: Row) => (row.action === 'Не правим' ? 1 : 0);
    rows.sort((a, b) => order(a) - order(b) || a.person.localeCompare(b.person, 'ru') || a.action.localeCompare(b.action, 'ru'));
    let n = 0;
    let lastBlock = -1;
    for (const row of rows) {
      if (order(row) !== lastBlock) {
        lastBlock = order(row);
        const title = sheet.addRow(['', lastBlock === 0 ? `Правим (с ${ruDate(from)} — как в 1С; въезд ${ruDate(realCheckInBefore)} — настоящий заезд)` : 'Не правим — для сведения']);
        title.font = { bold: true };
      }
      n += 1;
      const added = sheet.addRow([n, row.person, row.dormitory.replace(/^Общ\.\s*/, ''), row.action, row.was, row.now, row.why]);
      added.alignment = { vertical: 'top', wrapText: true };
      if (row.fill) added.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.fill as string } }; });
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const side: Array<[string, string | number]> = [
      ['Сверка 1С ↔ портал', `на ${ruDate(fileDate)}`],
      ['Изменить даты', updates.length],
      ['  из них въезд → настоящий заезд', counts.checkInReal],
      ['Заселить', adds.length],
      ['Удалить запись', deletes.length],
      ['Не правим (строк)', plan.notes.length],
      ['', ''],
      ['Цвет: зелёный', 'новая запись'],
      ['Цвет: розовый', 'запись удаляется'],
      ['Цвет: серый', 'не правим — расхождение для сведения'],
      ['', ''],
      ['Дата выезда', 'как в 1С: день выезда — уже не проживание'],
      ['Сентябрь–октябрь', 'не меняются (оплачены)'],
    ];
    side.forEach(([label, value], index) => {
      sheet.getCell(index + 1, 11).value = label;
      sheet.getCell(index + 1, 12).value = value;
    });
    sheet.getColumn(11).width = 34;
    sheet.getColumn(12).width = 44;
    sheet.getCell(1, 11).font = { bold: true };

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, sql, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(args.out, 0o600);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    fs.writeFileSync(args.xlsx, buffer, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(args.xlsx, 0o600);

    console.log(summary.join('\n'));
    console.log(`Не правим (заметок): ${plan.notes.length} — ${Object.entries(plan.notes.reduce<Record<string, number>>((acc, note) => ({ ...acc, [note.kind]: (acc[note.kind] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`Роль: ${role?.who}${args.db ? ' (тестовая база)' : ''}. Повтор плана на итоге — пустой.`);
    console.log(`SQL: ${args.out}\nСверка: ${args.xlsx}`);
  } finally {
    await closeDb();
  }
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
