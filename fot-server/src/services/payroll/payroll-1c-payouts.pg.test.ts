import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Перечислено (1С)» на настоящем PostgreSQL (миграция 328): новая ведомость, второй формат — дополнение,
// повтор — без записи, пересопоставление и замена с журналом, устаревшая ревизия и параллельные загрузки — 409,
// подменённый выбор — 400, подрядчик в месяце не кандидат, авто только по id_all, удаление сотрудника.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от
// других *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 8 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';
vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => CONTRACTORS }));

import { importPayouts1c, listEmployeePayouts1c, previewPayouts1c, type IPayoutPreview } from './payroll-1c-payouts.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const USER = '00000000-0000-0000-0000-0000000000aa';
const BRIGADE = '00000000-0000-0000-0000-0000000000b1';
const OTHER_BRIGADE = '00000000-0000-0000-0000-0000000000b2';
const CONTRACTOR_CO = '00000000-0000-0000-0000-0000000000c1';
const GUID = '11111111-2222-3333-4444-555555555555';
const GUID_2 = '11111111-2222-3333-4444-666666666666';
const GUID_3 = '11111111-2222-3333-4444-777777777777';
const ID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ID_B = 'aaaaaaaa-0000-0000-0000-000000000002';

interface IPerson { name: string; idAll: string | null; amount: string; brigade?: string }
// 1 и 4 — полные тёзки: 1 — бригада Петрова, 4 — сейчас у подрядчика (в сентябре — тоже, по табелю).
const IVANOV: IPerson = { name: 'Иванов Иван Иванович', idAll: ID_A, amount: '43500', brigade: 'бр.Петрова П.П.' };
const SIDOROV: IPerson = { name: 'Сидоров Сидор Сидорович', idAll: ID_B, amount: '31818,18', brigade: 'бр.Петров П.П.' };

const zup2 = (guid: string, people: IPerson[], total: string): Buffer => Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><зп_документы_31><имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя>'
  + '<ЗарплатаКВыплатеОрганизаций><документ><имя_док>ВедомостьНаВыплатуЗарплатыВБанк</имя_док>'
  + `<организация_инн>7736255508</организация_инн><Док_Гуид>${guid}</Док_Гуид><Док_Номер>0000-000077</Док_Номер>`
  + '<Док_Дата><Год>2026</Год><Мес>10</Мес><День>9</День></Док_Дата>'
  + '<ПериодРегистрации><Год>2026</Год><Мес>9</Мес><День>1</День></ПериодРегистрации>'
  + `<ЗарплатныйПроект>Банк №1</ЗарплатныйПроект><СпособВыплаты>Увольнения</СпособВыплаты><СуммаПоДокументу>${total}</СуммаПоДокументу>`
  + `<Зарплата>${people.map(p => `<расшифровка><ФизЛицо><код>00-1</код><наименование>${p.name}</наименование>`
    + `${p.idAll ? `<id_all>${p.idAll}</id_all>` : ''}</ФизЛицо><КВыплате>${p.amount}</КВыплате></расшифровка>`).join('')}</Зарплата>`
  + '<Зарплата_руководство/><отпуска/><Основания/></документ></ЗарплатаКВыплатеОрганизаций></зп_документы_31>',
  'utf8',
);

const external = (guid: string, people: IPerson[], total: string): Buffer => Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><ЗУП_ВЫПЛАТЫ><имя>ВыплатаЗПнаЛС</имя><Документы><Документ>'
  + `<док_гуид>${guid}</док_гуид><номер>00003123</номер><дата><Год>2026</Год><Мес>10</Мес><День>09</День></дата>`
  + `<сумма>${total}</сумма><периодо_регистрации><Год>2026</Год><Мес>09</Мес><День>01</День></периодо_регистрации>`
  + '<НомерБазаИсточник>0000-000077</НомерБазаИсточник><ДатаБазаИсточник><Год>2026</Год><Мес>10</Мес><День>09</День></ДатаБазаИсточник>'
  + '<СпособВыплаты>Увольнения</СпособВыплаты><фирма_представительская_инн>7736255508</фирма_представительская_инн>'
  + `<ЗарплатныйПроект></ЗарплатныйПроект><Сотрудники>${people.map(p => `<сотрудник><Сумма>${p.amount}</Сумма>`
    + `${p.idAll ? `<физ_лицо_id_all>${p.idAll}</физ_лицо_id_all>` : ''}<физ_лицо_имя>${p.name}</физ_лицо_имя>`
    + `<бригада_имя>${p.brigade ?? ''}</бригада_имя></сотрудник>`).join('')}</Сотрудники></Документ></Документы></ЗУП_ВЫПЛАТЫ>`,
  'utf8',
);

const TOTAL = '75318.18';

/** Выбор по ФИО: первый допустимый кандидат каждой строки без авто. */
const confirmAll = (preview: IPayoutPreview): Record<string, number | null> => Object.fromEntries(preview.lines
  .filter(line => line.auto_employee_id === null)
  .map(line => [line.fingerprint, line.candidates[0]?.employee_id ?? null]));

const doImport = async (buffer: Buffer, preview: IPayoutPreview, extra: {
  choices?: Record<string, number | null>; confirmReplace?: boolean; expectedRevision?: number;
} = {}) => importPayouts1c({
  buffer,
  fileName: 'C:\\temp\\ведомость.xml',
  userId: USER,
  incomingContentHash: preview.incoming_content_hash,
  expectedRevision: extra.expectedRevision ?? preview.expected_revision,
  confirmReplace: extra.confirmReplace ?? false,
  choices: extra.choices ?? {},
});

const docRow = async (guid: string) => (await run(
  `SELECT id, revision, zup2_number, salary_project, total_amount::text AS total FROM payroll_1c_payout_documents WHERE doc_guid = $1`,
  [guid],
)).rows[0];
const lineRows = async (documentId: number) => (await run(
  `SELECT line_no, full_name_1c, employee_id, resolution, brigade_1c, person_id_all::text AS id_all, amount::text AS amount
     FROM payroll_1c_payout_lines WHERE document_id = $1 ORDER BY line_no`,
  [documentId],
)).rows;
const journal = async (documentId: number) => (await run(
  `SELECT action, revision_before, revision_after, previous_header IS NOT NULL AS has_header,
          previous_lines IS NOT NULL AS has_lines, file_name, imported_by::text AS imported_by
     FROM payroll_1c_payout_imports WHERE document_id = $1 ORDER BY id`,
  [documentId],
)).rows;

describe.skipIf(!PG_URL)('«Перечислено (1С)» на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS payroll_1c_payout_imports, payroll_1c_payout_lines, payroll_1c_payout_documents,
        payroll_paid_amounts, employee_hr_profiles, employee_dismissal_events, timesheet_version_objects,
        timesheet_versions, employees, org_departments, user_profiles CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, name text NOT NULL);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text NOT NULL, employment_status text NOT NULL DEFAULT 'active',
        hire_date date, dismissal_date date, org_department_id uuid);
      CREATE TABLE employee_hr_profiles (employee_id integer PRIMARY KEY, passdesk_id_all uuid);
      CREATE TABLE employee_dismissal_events (employee_id integer, from_department_id uuid, cancelled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE timesheet_versions (id integer PRIMARY KEY, approval_id integer, revision integer, department_id uuid,
        start_date date, end_date date);
      CREATE TABLE timesheet_version_objects (version_id integer, payload jsonb);
      CREATE TABLE payroll_paid_amounts (employee_id integer, month date, item_code text, amount numeric(12,2));
      CREATE OR REPLACE FUNCTION public.get_descendant_department_ids(p_root_ids uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql STABLE AS $$
          WITH RECURSIVE tree AS (
            SELECT d.id FROM org_departments d WHERE d.id = ANY(p_root_ids)
            UNION ALL SELECT d.id FROM org_departments d JOIN tree t ON d.parent_id = t.id)
          SELECT tree.id FROM tree $$;
    `);
    await run(`INSERT INTO user_profiles VALUES ('${USER}')`);
    await run(`INSERT INTO org_departments (id, parent_id, name) VALUES
      ('${BRIGADE}', NULL, 'бр.Петров П.П.'), ('${OTHER_BRIGADE}', NULL, 'бр.Козлов К.К.'),
      ('${CONTRACTORS}', NULL, 'подрядные организации'), ('${CONTRACTOR_CO}', '${CONTRACTORS}', 'ТЕСТ ООО')`);
    await run(`INSERT INTO employees (id, full_name, employment_status, hire_date, dismissal_date, org_department_id) VALUES
      (1, 'Иванов Иван Иванович', 'fired', '2025-01-01', '2026-10-09', NULL),
      (2, 'Сидоров Сидор Сидорович', 'active', '2025-01-01', NULL, '${OTHER_BRIGADE}'),
      (3, 'Сидоров  Сидор сидорович', 'active', '2026-11-01', NULL, '${BRIGADE}'),
      (4, 'Иванов Иван Иванович', 'active', '2026-08-01', NULL, '${CONTRACTOR_CO}')`);
    // Уволенный 1 — отдел до увольнения; 4 в сентябре по табелю — у подрядчика.
    await run(`INSERT INTO employee_dismissal_events (employee_id, from_department_id) VALUES (1, '${BRIGADE}')`);
    await run(`INSERT INTO timesheet_versions VALUES (10, 100, 1, '${CONTRACTOR_CO}', '2026-09-01', '2026-09-15')`);
    await run(`INSERT INTO timesheet_version_objects VALUES (10, '{"employees":[{"employee_id":4,"objects":[]}]}')`);
    await run(`INSERT INTO payroll_paid_amounts VALUES (1, '2026-09-01', 'contract', 100000)`);
    await run(migration('328_payroll_1c_payouts.sql'));
    await run(migration('328_payroll_1c_payouts.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('новый документ: кандидаты только по ФИО, подрядчик в месяце исключён, бригада выше; без выбора — 400', async () => {
    const preview = await previewPayouts1c(external(GUID, [SIDOROV, IVANOV], TOTAL));
    expect(preview).toMatchObject({ status: 'new', expected_revision: 0, format: 'external' });
    const [sidorov, ivanov] = preview.lines;
    expect(ivanov.auto_employee_id).toBeNull();
    expect(ivanov.candidates.map(c => c.employee_id)).toEqual([1]);
    expect(sidorov.candidates.map(c => [c.employee_id, c.brigade_match, c.worked_in_month])).toEqual([[3, true, false], [2, false, true]]);
    await expect(doImport(external(GUID, [SIDOROV, IVANOV], TOTAL), preview)).rejects.toMatchObject({ status: 400 });
  });

  it('подменённый выбор (не кандидат, чужой отпечаток) — 400, ничего не записано', async () => {
    const buffer = external(GUID, [SIDOROV, IVANOV], TOTAL);
    const preview = await previewPayouts1c(buffer);
    const choices = confirmAll(preview);
    await expect(doImport(buffer, preview, { choices: { ...choices, [preview.lines[1].fingerprint]: 4 } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(doImport(buffer, preview, { choices: { ...choices, ['f'.repeat(64)]: 1 } }))
      .rejects.toMatchObject({ status: 400 });
    expect(await docRow(GUID)).toBeUndefined();
  });

  it('загрузка внешнего формата → new; ЗУП2 того же документа → enrich без потери подтверждений; повтор — без записи', async () => {
    const ext = external(GUID, [SIDOROV, IVANOV], TOTAL);
    const preview = await previewPayouts1c(ext);
    const choices = { [preview.lines[0].fingerprint]: 2, [preview.lines[1].fingerprint]: 1 };
    expect(await doImport(ext, preview, { choices })).toMatchObject({ action: 'new', revision: 1, lines_matched: 2 });
    const doc = await docRow(GUID);
    expect(doc).toMatchObject({ revision: 1, zup2_number: '00003123', salary_project: null, total: '75318.18' });
    expect(await lineRows(doc.id)).toMatchObject([
      { employee_id: 2, resolution: 'confirmed', brigade_1c: 'бр.Петров П.П.', id_all: ID_B },
      { employee_id: 1, resolution: 'confirmed', brigade_1c: 'бр.Петрова П.П.', id_all: ID_A },
    ]);

    const zup = zup2(GUID, [IVANOV, SIDOROV], '75 318,18');
    const zupPreview = await previewPayouts1c(zup);
    expect(zupPreview).toMatchObject({ status: 'enrich', expected_revision: 1, enrich_fields: ['зарплатный проект'] });
    expect(zupPreview.incoming_content_hash).toBe(preview.incoming_content_hash);
    expect(zupPreview.lines.map(line => line.current_employee_id)).toEqual([1, 2]);
    // id_all уже подтверждён — авто, но «confirmed» не превращается в «auto_id_all».
    expect(zupPreview.lines.map(line => line.auto_employee_id)).toEqual([1, 2]);
    expect(await doImport(zup, zupPreview)).toMatchObject({ action: 'enrich', revision: 2 });
    expect(await docRow(GUID)).toMatchObject({ revision: 2, salary_project: 'Банк №1', zup2_number: '00003123' });
    expect((await lineRows(doc.id)).map(line => [line.employee_id, line.resolution])).toEqual([[2, 'confirmed'], [1, 'confirmed']]);

    for (const buffer of [ext, zup]) {
      const again = await previewPayouts1c(buffer);
      expect(again.status).toBe('unchanged');
      expect(await doImport(buffer, again)).toMatchObject({ action: 'unchanged', revision: 2 });
    }
    expect((await journal(doc.id)).map(row => [row.action, row.revision_before, row.revision_after, row.has_header, row.has_lines]))
      .toEqual([['new', 0, 1, false, false], ['enrich', 1, 2, true, false]]);
    expect((await journal(doc.id))[0]).toMatchObject({ file_name: 'ведомость.xml', imported_by: USER });
  });

  it('другая ведомость с теми же людьми — авто по id_all из подтверждённых строк', async () => {
    const preview = await previewPayouts1c(external(GUID_2, [IVANOV], '43500'));
    expect(preview.lines[0].auto_employee_id).toBe(1);
    expect(await doImport(external(GUID_2, [IVANOV], '43500'), preview)).toMatchObject({ action: 'new', lines_matched: 1 });
    const doc = await docRow(GUID_2);
    expect((await lineRows(doc.id))[0]).toMatchObject({ employee_id: 1, resolution: 'auto_id_all' });
  });

  it('пересопоставление: «Без сотрудника» → relink с прежними строками в журнале; устаревшая ревизия — 409', async () => {
    const ext = external(GUID, [SIDOROV, IVANOV], TOTAL);
    const preview = await previewPayouts1c(ext);
    await expect(doImport(ext, preview, { expectedRevision: 1, choices: { [preview.lines[0].fingerprint]: null } }))
      .rejects.toMatchObject({ status: 409 });
    expect(await doImport(ext, preview, { choices: { [preview.lines[0].fingerprint]: null } }))
      .toMatchObject({ action: 'relink', revision: 3, lines_unmatched: 1 });
    const doc = await docRow(GUID);
    expect((await lineRows(doc.id))[0]).toMatchObject({ employee_id: null, resolution: 'unmatched' });
    expect((await journal(doc.id)).at(-1)).toMatchObject({ action: 'relink', has_lines: true });
  });

  it('изменённая ведомость: без подтверждения — 409; с подтверждением — replace, журнал с прежней шапкой и строками', async () => {
    const changed = external(GUID, [{ ...SIDOROV, amount: '31818' }, IVANOV], '75318');
    const preview = await previewPayouts1c(changed);
    expect(preview.status).toBe('changed');
    expect(preview.changes?.header).toEqual([{ field: 'Сумма документа', before: '75318.18', after: '75318.00' }]);
    expect(preview.changes?.added).toEqual(['Сидоров Сидор Сидорович — 31818.00']);
    expect(preview.changes?.removed).toEqual(['Сидоров Сидор Сидорович — 31818.18']);
    const choices = confirmAll(preview);
    await expect(doImport(changed, preview, { choices })).rejects.toMatchObject({ status: 409 });
    expect(await doImport(changed, preview, { choices, confirmReplace: true })).toMatchObject({ action: 'replace', revision: 4 });
    const doc = await docRow(GUID);
    expect(doc.total).toBe('75318.00');
    // Номер ЗУП2 и зарплатный проект не затёрты.
    expect(doc).toMatchObject({ zup2_number: '00003123', salary_project: 'Банк №1' });
    expect((await journal(doc.id)).at(-1)).toMatchObject({ action: 'replace', has_header: true, has_lines: true });
  });

  it('две параллельные загрузки нового документа — одна проходит, вторая 409', async () => {
    const buffer = external(GUID_3, [IVANOV], '43500');
    const preview = await previewPayouts1c(buffer);
    const results = await Promise.allSettled([doImport(buffer, preview), doImport(buffer, preview)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
  });

  it('авто по id_all — только один допустимый сотрудник: подрядчик и дубль кода в карточках — не авто', async () => {
    const ID_C = 'aaaaaaaa-0000-0000-0000-000000000003';
    const ID_D = 'aaaaaaaa-0000-0000-0000-000000000004';
    await run(`INSERT INTO employee_hr_profiles VALUES (4, '${ID_C}'), (1, '${ID_D}'), (2, '${ID_D}')`);
    const people = [{ ...IVANOV, idAll: ID_C }, { ...SIDOROV, idAll: ID_D }];
    const preview = await previewPayouts1c(external('11111111-2222-3333-4444-888888888888', people, TOTAL));
    expect(preview.lines.map(line => line.auto_employee_id)).toEqual([null, null]);
    // Подрядчик 4 не кандидат и по коду; при дубле кода оба его сотрудника — кандидаты (1 выше: совпала бригада),
    // за ними — тёзка по ФИО без кода.
    expect(preview.lines[0].candidates.map(c => c.employee_id)).toEqual([1]);
    expect(preview.lines[1].candidates.map(c => [c.employee_id, c.by_id_all])).toEqual([[1, true], [2, true], [3, false]]);
    await run('DELETE FROM employee_hr_profiles');
  });

  it('история сотрудника — по месяцу начисления; удаление сотрудника строки не удаляет; «Оплачено» не тронуто', async () => {
    expect(await listEmployeePayouts1c(1, '2026-09', '2026-09')).toEqual([
      expect.objectContaining({ month: '2026-09', doc_number: '0000-000077', doc_date: '2026-10-09', amount: '43500.00' }),
      expect.objectContaining({ month: '2026-09', amount: '43500.00' }),
      expect.objectContaining({ month: '2026-09', amount: '43500.00' }),
    ]);
    expect(await listEmployeePayouts1c(1, '2026-10', '2026-12')).toEqual([]);
    const doc = await docRow(GUID);
    // После замены строка Сидорова подтверждена за 3 (бригада выше в кандидатах).
    expect((await lineRows(doc.id))[0]).toMatchObject({ employee_id: 3, resolution: 'confirmed' });
    await run('DELETE FROM employees WHERE id = 3');
    expect((await lineRows(doc.id))[0]).toMatchObject({ employee_id: null, resolution: 'confirmed', amount: '31818.00' });
    expect((await run('SELECT count(*)::int AS n FROM payroll_1c_payout_lines WHERE document_id = $1', [doc.id])).rows[0].n).toBe(2);
    expect((await run('SELECT amount::text AS amount FROM payroll_paid_amounts')).rows).toEqual([{ amount: '100000.00' }]);
  });
});
