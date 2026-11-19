import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

// Загрузка физлиц 1С на настоящем PostgreSQL: предпросмотр → ручной выбор → запись → повтор →
// сверка → откат; конкурентная правка карточки, ошибка расшифровки, чёрный список, ЗУП.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;
const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 6 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

const bl = vi.hoisted(() => ({ snils: null as string | null }));
vi.mock('../blacklist.service.js', () => {
  class BlacklistBlockedError extends Error {
    constructor(message: string, readonly entries: unknown[]) { super(message); this.name = 'BlacklistBlockedError'; }
  }
  return {
    BlacklistBlockedError,
    findActive: async (q: { snils: string | null }) => (q.snils && q.snils === bl.snils
      ? { strong: [{ employee_id: 999, created_by_name: 'Служба безопасности', reason: 'тест' }], weak: [] }
      : { strong: [], weak: [] }),
  };
});

import { applyProfilePatch } from '../hr-profile.service.js';
import { encryptField, hashForSearch } from '../hr-crypto.service.js';
import { runApply, runPreview, readJournal } from './run.js';
import { runRollback, runVerify } from './audit.js';
import { readReport } from './report.js';
import { applyPersonInTransaction } from './apply.js';
import { personKeys } from './facts.js';
import { collapsePersons, parsePersons1cRows, PERSONS_1C_REQUIRED_COLUMNS } from './parse.js';
import { HrIntegrityError } from './fill.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (f: string): string => fs.readFileSync(`${MIGRATIONS_DIR}${f}`, 'utf8');
const q = async <T extends import('pg').QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const makeInn = (ten: string): string => {
  const n = (d: string, w: number[]): number => w.reduce((s, x, i) => s + x * Number(d[i]), 0) % 11 % 10;
  const eleven = ten + n(ten, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return eleven + n(eleven, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
};
const makeSnils = (nine: string): string => {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(nine[i]) * (9 - i);
  let c = sum < 100 ? sum : sum % 101;
  if (c === 100) c = 0;
  return nine + String(c).padStart(2, '0');
};

const USER = '00000000-0000-0000-0000-0000000000a1';
const DEPT = '00000000-0000-0000-0000-00000000d001';
const id = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const AS_OF = '2026-11-19';

type Row = Partial<Record<typeof PERSONS_1C_REQUIRED_COLUMNS[number], string>>;
const person = (n: number, name: string, over: Row = {}): Row => ({
  'ФизЛицо': name, 'Физлицо_id_all': id(n), 'Отдел': 'бр.Новая', 'ДатаРождения': `0${n % 9 + 1}.01.1990`,
  'СтраховойНомерПФР': makeSnils(`1${String(n).padStart(8, '0')}`), 'ИНН': makeInn(`77${String(n).padStart(8, '0')}`),
  'Гражданство': 'УЗБЕКИСТАН', 'Паспорт_Вид': 'Паспорт иностранного гражданина', 'Паспорт_Серия': 'FA',
  'Паспорт_Номер': String(1000000 + n), 'Паспорт_ДатаВыдачи': '08.02.2021', 'Паспорт_КемВыдан': 'МВД 10242',
  'Паспорт_ФМС_ДокументСрокДействия': '07.02.2031', 'Патент_Серия': '77', 'Патент_Номер': String(2400000000 + n),
  'Патент_ДатаВыдачи': '07.02.2024', 'КИГ': `ВС${String(1000000 + n)}`, 'ТелефонФЛ': `8925${String(1000000 + n)}`, ...over,
});

const writeSource = async (file: string, rows: Row[]): Promise<void> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TDSheet');
  ws.addRow([...PERSONS_1C_REQUIRED_COLUMNS]);
  for (const r of rows) ws.addRow(PERSONS_1C_REQUIRED_COLUMNS.map(c => r[c] ?? null));
  await wb.xlsx.writeFile(file);
};

const P = {
  linked: person(1, 'Алиев Али'),             // код 1С по выплатам → #101, профиля нет
  bySnils: person(2, 'Бобоев Бобо'),          // СНИЛС в карточке #102, профиль с ЗУП и другим паспортом
  byName: person(3, 'Валиев Вали'),           // только ФИО + отдел → #103
  twoCards: person(4, 'Гафуров Гафур'),       // две карточки #104/#105 → вручную, потом выбор #104
  vetoBirth: person(5, 'Давлатов Давлат'),    // код 1С → #106, но другая ДР → вручную
  dismissed: person(6, 'Ергашев Ерга', { 'ДатаУвольнения': '01.10.2026' }),
  badCipher: person(7, 'Жураев Жура'),        // код 1С → #107, шифротекст ИНН битый
  blacklisted: person(8, 'Зиёев Зиё'),        // код 1С → #108, чёрный список при записи
};

const d = PG_URL ? describe : describe.skip;

d('физлица 1С → «Реквизиты» на PostgreSQL', () => {
  let dir = '';
  let src = '';
  let report = '';
  let journal = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-1c-persons-'));
    src = path.join(dir, 'fiz.xlsx');
    report = path.join(dir, 'preview.xlsx');
    journal = path.join(dir, 'apply.jsonl');
    await q(`DROP TABLE IF EXISTS hr_profile_import_staging, hr_external_refs, hr_ocr_jobs, hr_identity_claims, employee_hr_drafts,
             employee_hr_ocr_conflicts, employee_hr_profile_history, employee_hr_profiles, hr_citizenship_synonyms, hr_citizenships,
             documents, document_categories, access_pages, user_profiles, payroll_1c_payout_lines, payroll_fss_payments,
             org_departments, employees CASCADE`);
    await q(`CREATE TABLE org_departments (id uuid PRIMARY KEY, name text)`);
    await q(`CREATE TABLE employees (
               id integer PRIMARY KEY, full_name text, last_name text, first_name text, middle_name text, birth_date date, email text,
               pension_number text, patent_issue_date date, patent_expiry_date date, employment_status text NOT NULL DEFAULT 'active',
               hire_date date, org_department_id uuid, tab_number text, country text, dismissal_date date,
               is_archived boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text)`);
    await q(`CREATE TABLE documents (id bigserial PRIMARY KEY, employee_id integer, category text)`);
    await q(`CREATE TABLE document_categories (code text PRIMARY KEY, label text NOT NULL, sort_order integer)`);
    await q(`CREATE TABLE access_pages (key text PRIMARY KEY, label text, group_code text, group_label text, area text, surface text,
               supports_edit boolean, sort_order integer, is_active boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
    await q(`CREATE TABLE payroll_1c_payout_lines (id serial PRIMARY KEY, employee_id integer, person_id_all uuid, resolution text NOT NULL)`);
    await q(`CREATE TABLE payroll_fss_payments (id serial PRIMARY KEY, employee_id integer, person_id_all uuid)`);
    for (const f of ['258_hr_citizenships.sql', '259_employee_hr_profiles.sql', '260_hr_drafts_ocr_refs.sql']) await pg.pool!.query(migration(f));

    await q(`INSERT INTO user_profiles (id, full_name) VALUES ($1, 'Кадровик')`, [USER]);
    await q(`INSERT INTO org_departments (id, name) VALUES ($1, 'бр. Новая')`, [DEPT]);
    const emp = (empId: number, name: string, extra = ''): Promise<unknown> =>
      q(`INSERT INTO employees (id, full_name, org_department_id) VALUES ($1, $2, $3)${extra}`, [empId, name, DEPT]);
    for (const [empId, row] of [[101, P.linked], [102, P.bySnils], [103, P.byName], [104, P.twoCards], [105, P.twoCards],
      [106, P.vetoBirth], [107, P.badCipher], [108, P.blacklisted]] as Array<[number, Row]>) await emp(empId, row['ФизЛицо']!);
    await q(`UPDATE employees SET pension_number = $1 WHERE id = 102`, [P.bySnils['СтраховойНомерПФР']]);
    await q(`UPDATE employees SET birth_date = '1970-01-01' WHERE id = 106`);
    await q(`UPDATE employees SET country = 'УЗБЕКИСТАН' WHERE id = 101`);
    for (const [empId, n] of [[101, 1], [106, 5], [107, 7], [108, 8]]) {
      await q(`INSERT INTO payroll_1c_payout_lines (employee_id, person_id_all, resolution) VALUES ($1, $2, 'confirmed')`, [empId, id(n)]);
    }
    // #102: профиль с флагом ЗУП, заполненным телефоном и паспортом РФ (в 1С — иностранный).
    await q(`INSERT INTO employee_hr_profiles (employee_id, phone, passport_type, zup_is_uploaded, created_by)
             VALUES (102, '+70000000000', 'russian', true, $1)`, [USER]);
    // #107: шифротекст ИНН не расшифровывается, хэш при этом «правильный».
    await q(`INSERT INTO employee_hr_profiles (employee_id, inn_enc, inn_hash, inn_key_version, created_by)
             VALUES (107, 'v0:AAAA:BBBB:CCCC', $1, 'v0', $2)`, [hashForSearch('inn', P.badCipher['ИНН']), USER]);

    await writeSource(src, Object.values(P));
    bl.snils = P.blacklisted['СтраховойНомерПФР']!;
  });

  afterAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await pg.pool?.end();
  });

  const events = async (empId: number) => q<{ event_type: string; changed_fields: string[] | null; changed_by_name: string }>(
    `SELECT event_type, changed_fields, changed_by_name FROM employee_hr_profile_history WHERE employee_id = $1 ORDER BY id`, [empId]);

  it('предпросмотр: решения и права 600, ничего не пишет', async () => {
    const stats = await runPreview({ file: src, asOf: AS_OF, out: report });
    expect((fs.statSync(report).mode & 0o777).toString(8)).toBe('600');
    expect(stats.get('Работают на дату среза')).toBe(7);
    expect(stats.get('Проверить вручную')).toBe(3); // две карточки, вето ДР, битый шифротекст
    const sha = (await import('./parse.js')).sha256OfBuffer(fs.readFileSync(src));
    const decisions = await readReport(report, { sourceSha256: sha, asOf: AS_OF });
    expect(decisions.get(id(1))).toEqual({ previewKind: 'apply', previewEmployeeId: 101, manualEmployeeId: null });
    expect(decisions.get(id(2))?.previewEmployeeId).toBe(102);
    expect(decisions.get(id(3))?.previewEmployeeId).toBe(103);
    expect(decisions.get(id(4))?.previewKind).toBe('manual');
    expect(decisions.get(id(7))?.previewKind).toBe('manual');
    expect(decisions.has(id(6))).toBe(false);
    expect(await q(`SELECT 1 FROM employee_hr_profile_history`)).toHaveLength(0);
  });

  it('отчёт с другим исходником или изменённой датой среза не принимается', async () => {
    await expect(readReport(report, { sourceSha256: '0'.repeat(64), asOf: AS_OF })).rejects.toThrow(/SHA-256/);
    const sha = (await import('./parse.js')).sha256OfBuffer(fs.readFileSync(src));
    await expect(readReport(report, { sourceSha256: sha, asOf: '2026-11-20' })).rejects.toThrow(/Дата среза/);
  });

  it('запись: только пустые поля, ЗУП сохранён, паспорт с расхождением не тронут, чёрный список — ошибка без записи', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(report);
    const ws = wb.getWorksheet('Сверка')!;
    ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value === id(4)) row.getCell(12).value = 104; });
    await wb.xlsx.writeFile(report);

    const stats = await runApply({ file: src, asOf: AS_OF, report, journal, userId: USER });
    expect(stats.get('planned')).toBe(5);
    expect(stats.get('applied')).toBe(4);
    expect(stats.get('error')).toBe(1);
    expect(stats.get('manual_pending')).toBe(2);
    expect((fs.statSync(journal).mode & 0o777).toString(8)).toBe('600');

    const p101 = (await q(`SELECT p.passdesk_id_all::text AS id_all, p.inn_hash, p.passport_number_hash, p.passport_type, p.match_rule,
                                  e.birth_date::text AS birth_date, e.pension_number, e.patent_issue_date::text AS pid, e.country
                             FROM employee_hr_profiles p JOIN employees e ON e.id = p.employee_id WHERE p.employee_id = 101`))[0];
    expect(p101).toMatchObject({
      id_all: id(1), inn_hash: hashForSearch('inn', P.linked['ИНН']), passport_number_hash: hashForSearch('passport', 'FA1000001'),
      passport_type: 'foreign', match_rule: '1c:id_all', birth_date: '1990-01-02', pension_number: P.linked['СтраховойНомерПФР'],
      pid: '2024-02-07', country: 'УЗБЕКИСТАН',
    });
    const ev101 = await events(101);
    expect(ev101.map(e => e.event_type)).toEqual(['created', 'profile_update', 'profile_update']);
    expect(ev101[2].changed_fields).toEqual(['passdesk_id_all']);
    expect(ev101.every(e => /^Загрузка физлиц 1С · run [0-9a-f]{8}$/.test(e.changed_by_name))).toBe(true);

    const p102 = (await q(`SELECT phone, passport_type, passport_number_enc, zup_is_uploaded, inn_hash FROM employee_hr_profiles WHERE employee_id = 102`))[0];
    expect(p102).toMatchObject({ phone: '+70000000000', passport_type: 'russian', passport_number_enc: null, zup_is_uploaded: true });
    expect(p102.inn_hash).toBe(hashForSearch('inn', P.bySnils['ИНН']));

    expect((await q(`SELECT passdesk_id_all::text AS v FROM employee_hr_profiles WHERE employee_id = 104`))[0]?.v).toBe(id(4));
    expect(await q(`SELECT 1 FROM employee_hr_profiles WHERE employee_id IN (105, 106, 108)`)).toHaveLength(0);
    const { items } = readJournal(journal);
    expect(items.find(i => i.employee_id === 108)).toMatchObject({ status: 'error' });
    expect(items.find(i => i.employee_id === 108)!.reason).toMatch(/BlacklistBlockedError/);
  });

  it('повтор записи: ничего не меняется, новых событий нет', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM employee_hr_profile_history`))[0].n;
    const stats = await runApply({ file: src, asOf: AS_OF, report, journal: path.join(dir, 'apply-2.jsonl'), userId: USER });
    expect(stats.get('applied') ?? 0).toBe(0);
    expect(stats.get('unchanged')).toBe(4);
    expect((await q(`SELECT count(*)::int AS n FROM employee_hr_profile_history`))[0].n).toBe(before);
  });

  it('сверка: все записанные поля равны 1С, история = журналу', async () => {
    const res = await runVerify({ file: src, journal });
    expect(res.problems).toEqual([]);
    expect(res.counts.get('людей сверено')).toBe(4);
    expect(res.counts.get('профилей создано')).toBe(3);
    expect(res.counts.get('кодов 1С проставлено')).toBe(4);
  });

  it('откат: поле, изменённое человеком, остаётся; созданный и нетронутый профиль удаляется', async () => {
    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await applyProfilePatch(client, 101, { phone: '+79990000000' }, { userId: USER, userName: 'Кадровик' }, 'admin');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const res = await runRollback({ file: src, journal, userId: USER });
    expect(res.problems).toEqual(['#101: поле «phone» после записи менялось — оставлено']);
    const p101 = (await q(`SELECT phone, inn_enc, passdesk_id_all, citizenship_id FROM employee_hr_profiles WHERE employee_id = 101`))[0];
    expect(p101).toMatchObject({ phone: '+79990000000', inn_enc: null, passdesk_id_all: null, citizenship_id: null });
    expect((await q(`SELECT country, birth_date FROM employees WHERE id = 101`))[0]).toEqual({ country: 'УЗБЕКИСТАН', birth_date: null });
    expect(await q(`SELECT 1 FROM employee_hr_profiles WHERE employee_id IN (103, 104)`)).toHaveLength(0);
    const p102 = (await q(`SELECT phone, passport_type, inn_enc, zup_is_uploaded, passdesk_id_all FROM employee_hr_profiles WHERE employee_id = 102`))[0];
    expect(p102).toMatchObject({ phone: '+70000000000', passport_type: 'russian', inn_enc: null, zup_is_uploaded: true, passdesk_id_all: null });
    expect((await q(`SELECT pension_number FROM employees WHERE id = 102`))[0].pension_number).toBe(P.bySnils['СтраховойНомерПФР']);
    expect(await q(`SELECT 1 FROM hr_identity_claims WHERE employee_id IN (101, 103, 104)`)).toHaveLength(0);
    // СНИЛС #102 был в карточке до записи — его резерв остаётся.
    expect(await q(`SELECT claim_type FROM hr_identity_claims WHERE employee_id = 102`)).toEqual([{ claim_type: 'snils' }]);
  });

  it('конкурентная правка: запись ждёт блокировку и по свежим данным отказывается', async () => {
    const [p] = collapsePersons(parsePersons1cRows([[...PERSONS_1C_REQUIRED_COLUMNS],
      PERSONS_1C_REQUIRED_COLUMNS.map(c => person(9, 'Иргашев Ирга')[c] ?? '')]).rows, AS_OF).working;
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES (109, 'Иргашев Ирга', $1)`, [DEPT]);
    await q(`INSERT INTO payroll_1c_payout_lines (employee_id, person_id_all, resolution) VALUES (109, $1, 'confirmed')`, [id(9)]);
    const holder = await pg.pool!.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM employees WHERE id = 109 FOR UPDATE`);
      const { withTransaction } = await import('../../config/postgres.js');
      const pending = withTransaction(c => applyPersonInTransaction(c, {
        person: p, keys: personKeys(p), expectedEmployeeId: 109, manualEmployeeId: null, citizenship: null, asOf: AS_OF,
        actor: { userId: USER, userName: 'тест' },
      }));
      await new Promise(r => setTimeout(r, 300));
      await holder.query(`UPDATE employees SET birth_date = '1966-06-06' WHERE id = 109`);
      await holder.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe('skipped_changed');
      expect(res.reasons).toContain('в FOT другая дата рождения');
    } finally {
      holder.release();
    }
    expect(await q(`SELECT 1 FROM employee_hr_profiles WHERE employee_id = 109`)).toHaveLength(0);
  });

  it('битый шифротекст — ошибка, а не «пусто»: поле не перезаписывается', async () => {
    const [p] = collapsePersons(parsePersons1cRows([[...PERSONS_1C_REQUIRED_COLUMNS],
      PERSONS_1C_REQUIRED_COLUMNS.map(c => P.badCipher[c] ?? '')]).rows, AS_OF).working;
    const { withTransaction } = await import('../../config/postgres.js');
    await expect(withTransaction(c => applyPersonInTransaction(c, {
      person: p, keys: personKeys(p), expectedEmployeeId: 107, manualEmployeeId: null, citizenship: null, asOf: AS_OF,
      actor: { userId: USER, userName: 'тест' },
    }))).rejects.toBeInstanceOf(HrIntegrityError);
    expect((await q(`SELECT inn_enc FROM employee_hr_profiles WHERE employee_id = 107`))[0].inn_enc).toBe('v0:AAAA:BBBB:CCCC');
  });

  const directApply = async (n: number, name: string, empId: number) => {
    const [p] = collapsePersons(parsePersons1cRows([[...PERSONS_1C_REQUIRED_COLUMNS],
      PERSONS_1C_REQUIRED_COLUMNS.map(c => person(n, name)[c] ?? '')]).rows, AS_OF).working;
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES ($1, $2, $3)`, [empId, name, DEPT]);
    await q(`INSERT INTO payroll_1c_payout_lines (employee_id, person_id_all, resolution) VALUES ($1, $2, 'confirmed')`, [empId, id(n)]);
    return { p, run: async () => {
      const { withTransaction } = await import('../../config/postgres.js');
      return withTransaction(c => applyPersonInTransaction(c, {
        person: p, keys: personKeys(p), expectedEmployeeId: empId, manualEmployeeId: null, citizenship: null, asOf: AS_OF,
        actor: { userId: USER, userName: 'тест' },
      }));
    } };
  };

  it('ИНН закреплён за другим сотрудником — запись отказывается, ничего не пишет', async () => {
    const { p, run } = await directApply(10, 'Каримов Карим', 110);
    await q(`INSERT INTO employees (id, full_name) VALUES (910, 'Другой')`);
    await q(`INSERT INTO hr_identity_claims (claim_type, claim_hash, employee_id) VALUES ('inn', $1, 910)`, [hashForSearch('inn', p.inn)]);
    const res = await run();
    expect(res.status).toBe('skipped_changed');
    // ИНН сам указывает на #910 — признаки разошлись, запись блокируется.
    expect(res.reasons.join(';')).toMatch(/#910/);
    expect(await q(`SELECT 1 FROM employee_hr_profiles WHERE employee_id = 110`)).toHaveLength(0);
  });

  it('у карточки уже другой код 1С — запись отказывается, код не меняется', async () => {
    const { run } = await directApply(11, 'Латипов Латип', 111);
    await q(`INSERT INTO employee_hr_profiles (employee_id, passdesk_id_all, created_by) VALUES (111, $1, $2)`, [id(99), USER]);
    const res = await run();
    expect(res.status).toBe('skipped_changed');
    expect(res.reasons.join(';')).toMatch(/другой код 1С|другим физлицом/);
    expect((await q(`SELECT passdesk_id_all::text AS v, inn_enc FROM employee_hr_profiles WHERE employee_id = 111`))[0]).toEqual({ v: id(99), inn_enc: null });
  });

  it('шифрование в тесте настоящее', () => {
    expect(encryptField('x').enc).toMatch(/^v0:/);
  });
});
