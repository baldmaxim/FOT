import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Ведомости выплаты по API на настоящем PostgreSQL (миграции 328, 366, 367, 379 и повтор 379): новая → повтор →
// конфликт версии → замена → старая версия → отмена (шапка и журнал целы) → повтор отмены → возврат новой версией;
// надгробие неизвестного ГУИДа; ведомость из файла — «уже загружена», конфликт денег, отмена не своей; триггер против
// правки ведомости API в обход API; dry-run и запись без версии; откат выгрузки; «занято»; журнал ведомостей и окно
// сотрудника (одна ведомость — одна строка); ведомость из файла → под API (решения ФОТ, отмена, возврат, откат);
// «ЗП к выплате» снимается и возвращается. Сотрудники строк замоканы
// (resolvePayoutApiLines — свой тест). Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД.

const PG_URL = process.env.FOT_TEST_PG_URL;
const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await pg.pool!.query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await pg.pool!.query(sql, params as unknown[])).rows[0] ?? null,
  };
});

vi.mock('./payroll-1c-payouts.api-lines.js', () => ({
  resolvePayoutApiLines: vi.fn(async (doc: { lines: Array<{ lineKey: string; idFot: number | null }> }) => doc.lines.map(line => (
    line.idFot !== null
      ? { lineKey: line.lineKey, employeeId: line.idFot, resolution: 'auto_id_fot', reason: 'API 1С: по ID_FOT', warning: null }
      : { lineKey: line.lineKey, employeeId: null, resolution: 'unmatched', reason: 'API 1С: нет в ФОТ — без сотрудника', warning: null }
  ))),
}));

import { applyPayoutsApi, cancelPayoutsApi, PayoutApiError } from './payroll-1c-payouts.api.service.js';
import { rollbackPayoutApiBatch } from './payroll-1c-payouts.api-rollback.js';
import { getPayoutJournalDoc, listPayoutJournal } from './payroll-1c-payouts.journal.js';
import { parsePayout1cApiXml } from './payroll-1c-payouts.month-xml.js';
import { listEmployeePayouts1c } from './payroll-1c-payouts.service.js';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../docs/migrations/${name}`, import.meta.url)), 'utf8');
const sql = async (text: string, params: unknown[] = []) => (await pg.pool!.query(text, params)).rows;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

interface ILine { name: string; amount: string; idFot?: number; basis?: string }
const xmlDoc = (input: { guid: string; version?: number; number?: string; method?: string; month?: number; comment?: string; lines: ILine[] }) => {
  const total = input.lines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0) / 100;
  return `<документ><имя_док>ВедомостьНаВыплатуЗарплатыВБанк</имя_док><организация_инн>7736255508</организация_инн>
    <организация_имя>ООО "СУ-10"</организация_имя><Док_Гуид>${input.guid}</Док_Гуид>
    ${input.version === undefined ? '' : `<Док_Версия>${input.version}</Док_Версия>`}
    <Док_Номер>${input.number ?? '0000-003001'}</Док_Номер><Док_Дата><Год>2026</Год><Мес>11</Мес><День>20</День></Док_Дата>
    <ПериодРегистрации><Год>2026</Год><Мес>${input.month ?? 11}</Мес><День>1</День></ПериодРегистрации>
    <СпособВыплаты>${input.method ?? 'Аванс'}</СпособВыплаты><СуммаПоДокументу>${total.toFixed(2)}</СуммаПоДокументу>
    ${input.comment ? `<Комментарий>${input.comment}</Комментарий>` : ''}
    <Зарплата>${input.lines.map(line => `<расшифровка><ФизЛицо><наименование>${line.name}</наименование>
      ${line.idFot ? `<ID_FOT>${line.idFot}</ID_FOT>` : ''}</ФизЛицо><КВыплате>${line.amount}</КВыплате>
      ${line.basis ? `<Основание>${line.basis}</Основание>` : ''}</расшифровка>`).join('')}</Зарплата></документ>`;
};
const xml = (...docs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><зп_документы_31><имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя>
  <версия>1.0</версия><ЗарплатаКВыплатеОрганизаций>${docs.join('')}</ЗарплатаКВыплатеОрганизаций></зп_документы_31>`;
const post = (body: string, dryRun = false) => applyPayoutsApi({ xml: body, keyId: null, dryRun });
const cancel = (items: Array<{ guid: string; version: number }>) => cancelPayoutsApi({ items, keyId: null, bodySha: HASH });
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return err instanceof PayoutApiError ? err.code : `other: ${err instanceof Error ? err.message : String(err)}`;
  }
};
const lines = async (guid: string) => sql(
  `SELECT l.full_name_1c, l.amount::text AS amount, l.employee_id, l.resolution, l.basis, l.id_fot_1c
     FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
    WHERE d.doc_guid = $1::uuid ORDER BY l.line_no`, [guid]);
const state = async (guid: string) => (await sql(
  'SELECT version::int AS version, state, document_id IS NOT NULL AS has_doc FROM payroll_1c_payout_api_states WHERE doc_guid = $1::uuid', [guid]))[0];
const journal = async (guid: string) => (await sql(
  `SELECT i.action FROM payroll_1c_payout_imports i JOIN payroll_1c_payout_documents d ON d.id = i.document_id
    WHERE d.doc_guid = $1::uuid ORDER BY i.id`, [guid])).map(row => row.action);

const V1 = xmlDoc({ guid: G1, version: 1, comment: 'Аванс за ноябрь', lines: [{ name: 'Иванов Иван', amount: '1000.00', idFot: 1, basis: 'аванс' }, { name: 'Пётр Неизвестный', amount: '500.00' }] });

describe.skipIf(!PG_URL)('payroll-1c-payouts.api — PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS payroll_1c_payout_api_states, payroll_1c_payout_api_batches, payroll_1c_payout_imports,
                 payroll_1c_payout_lines, payroll_1c_payout_documents, employee_hr_profiles, employees, user_profiles,
                 data_api_keys, schema_migrations CASCADE`);
    await sql('CREATE TABLE employees (id int PRIMARY KEY)');
    await sql('CREATE TABLE user_profiles (id uuid PRIMARY KEY)');
    await sql('CREATE TABLE data_api_keys (id uuid PRIMARY KEY)');
    await sql('CREATE TABLE employee_hr_profiles (employee_id int PRIMARY KEY, passdesk_id_all uuid)');
    await sql('INSERT INTO employees VALUES (1), (2)');
    for (const name of ['328_payroll_1c_payouts.sql', '366_payroll_1c_payouts_sm_inn.sql', '367_payroll_payouts_brigade_sheet.sql',
      '379_payroll_1c_payouts_api.sql', '379_payroll_1c_payouts_api.sql']) {
      await sql(read(name));
    }
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('версии, замена, отмена и возврат, надгробие, откат', async () => {
    // Новая.
    const [created] = await post(xml(V1));
    expect(created).toMatchObject({ action: 'new', version: 1, lines: 2, lines_matched: 1, lines_unmatched: 1, period_month: '2026-11' });
    expect(created.unmatched).toEqual([{ full_name: 'Пётр Неизвестный', amount: '500.00', reason: 'API 1С: нет в ФОТ — без сотрудника' }]);
    expect(await lines(G1)).toEqual([
      { full_name_1c: 'Иванов Иван', amount: '1000.00', employee_id: 1, resolution: 'auto_id_fot', basis: 'аванс', id_fot_1c: 1 },
      { full_name_1c: 'Пётр Неизвестный', amount: '500.00', employee_id: null, resolution: 'unmatched', basis: null, id_fot_1c: null },
    ]);
    expect((await sql('SELECT origin, comment FROM payroll_1c_payout_documents WHERE doc_guid = $1::uuid', [G1]))[0])
      .toEqual({ origin: 'api', comment: 'Аванс за ноябрь' });
    expect(await state(G1)).toEqual({ version: 1, state: 'active', has_doc: true });

    // Повтор той же версии — без изменений; та же версия с другим содержимым — конфликт, ничего не записано.
    expect((await post(xml(V1)))[0].action).toBe('unchanged');
    const changedSameVersion = xmlDoc({ guid: G1, version: 1, lines: [{ name: 'Иванов Иван', amount: '1100.00', idFot: 1 }] });
    expect(await codeOf(post(xml(changedSameVersion)))).toBe('revision_conflict');
    expect(await journal(G1)).toEqual(['new']);

    // Новая версия — замена; старая после неё — stale.
    const V2 = xmlDoc({ guid: G1, version: 2, lines: [{ name: 'Иванов Иван', amount: '1200.00', idFot: 1 }] });
    expect((await post(xml(V2)))[0].action).toBe('replace');
    expect((await post(xml(V1)))[0].action).toBe('stale');
    expect((await lines(G1)).map(line => line.amount)).toEqual(['1200.00']);
    expect(await journal(G1)).toEqual(['new', 'replace']);

    // Отмена версии 3: строки убраны, шапка и журнал целы; повтор — unchanged; старая — stale; проведение v3 — stale.
    expect(await cancel([{ guid: G1, version: 3 }])).toEqual([{ index: 0, guid: G1, version: 3, action: 'cancelled', found: true, warnings: [] }]);
    expect(await lines(G1)).toEqual([]);
    expect(await state(G1)).toEqual({ version: 3, state: 'cancelled', has_doc: true });
    expect(await journal(G1)).toEqual(['new', 'replace', 'cancel']);
    expect((await cancel([{ guid: G1, version: 3 }]))[0].action).toBe('unchanged');
    expect((await cancel([{ guid: G1, version: 2 }]))[0].action).toBe('stale');
    expect((await post(xml(xmlDoc({ guid: G1, version: 3, lines: [{ name: 'Иванов Иван', amount: '1200.00', idFot: 1 }] }))))[0].action).toBe('stale');

    // Проведение версии 4 — ведомость возвращается.
    const V4 = xmlDoc({ guid: G1, version: 4, lines: [{ name: 'Иванов Иван', amount: '1300.00', idFot: 1 }] });
    expect((await post(xml(V4)))[0].action).toBe('restore');
    expect((await lines(G1)).map(line => line.amount)).toEqual(['1300.00']);

    // Откат последней выгрузки (restore v4) возвращает отменённое состояние; повторный откат — отказ.
    const [lastBatch] = await sql(`SELECT batch_id::text AS id FROM payroll_1c_payout_api_batches ORDER BY received_at DESC, batch_id LIMIT 1`);
    const checked = await rollbackPayoutApiBatch({ batchId: lastBatch.id, by: 'Тест', apply: false });
    expect(checked.applied).toBe(false);
    expect((await lines(G1)).map(line => line.amount)).toEqual(['1300.00']);
    await rollbackPayoutApiBatch({ batchId: lastBatch.id, by: 'Тест', apply: true });
    expect(await lines(G1)).toEqual([]);
    expect(await state(G1)).toEqual({ version: 3, state: 'cancelled', has_doc: true });
    await expect(rollbackPayoutApiBatch({ batchId: lastBatch.id, by: 'Тест', apply: true })).rejects.toThrow('уже откатана');
    // Откат первой выгрузки после изменений — отказ целиком.
    const [firstBatch] = await sql(`SELECT b.batch_id::text AS id FROM payroll_1c_payout_api_batches b
                                     WHERE b.changes @> '[{"action": "new"}]' ORDER BY received_at LIMIT 1`);
    await expect(rollbackPayoutApiBatch({ batchId: firstBatch.id, by: 'Тест', apply: true })).rejects.toThrow('Откат невозможен');

    // Надгробие: отмена неизвестного ГУИДа, поздняя старая версия не оживляет, новая — создаёт; откат новой — удаляет.
    expect((await cancel([{ guid: G2, version: 5 }]))[0]).toMatchObject({ action: 'cancelled', found: false });
    expect(await state(G2)).toEqual({ version: 5, state: 'cancelled', has_doc: false });
    const G2doc = (version: number) => xmlDoc({ guid: G2, version, number: '0000-003002', lines: [{ name: 'Иванов Иван', amount: '10.00', idFot: 1 }] });
    expect((await post(xml(G2doc(4))))[0].action).toBe('stale');
    expect((await post(xml(G2doc(6))))[0].action).toBe('new');
    const [g2Batch] = await sql(`SELECT batch_id::text AS id FROM payroll_1c_payout_api_batches ORDER BY received_at DESC, batch_id LIMIT 1`);
    await rollbackPayoutApiBatch({ batchId: g2Batch.id, by: 'Тест', apply: true });
    expect(await sql('SELECT id FROM payroll_1c_payout_documents WHERE doc_guid = $1::uuid', [G2])).toEqual([]);
    expect(await state(G2)).toEqual({ version: 5, state: 'cancelled', has_doc: false });
  });

  it('владение, триггер, dry-run, версия обязательна, «занято»', async () => {
    // Ведомость бригады с тем же номером и датой: те же деньги — «уже загружена», другие — конфликт, отмена — не своей.
    await sql(`INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, doc_date, period_month, payment_method,
                 organization_inn, total_amount, content_hash, revision, origin, source)
               VALUES ($1::uuid, '0000-009001', '2026-11-20', '2026-10-01', 'Премии', '7736255508', 300, $2, 1, 'brigade_sheet', 'brigade_sheet')`, [G3, HASH]);
    const same = xmlDoc({ guid: G3, version: 1, number: '0000-009001', method: 'Премии', lines: [{ name: 'Иванов Иван', amount: '300.00', idFot: 1 }] });
    const [loaded] = await post(xml(same));
    expect(loaded.action).toBe('already_loaded');
    expect(loaded.differences).toEqual(['месяц: в ФОТ 2026-10, из 1С 2026-11', 'строк: в ФОТ 0, из 1С 1']);
    const other = xmlDoc({ guid: G3, version: 2, number: '0000-009001', method: 'Премии', lines: [{ name: 'Иванов Иван', amount: '301.00', idFot: 1 }] });
    expect(await codeOf(post(xml(other)))).toBe('duplicate_conflict');
    expect(await codeOf(cancel([{ guid: G3, version: 9 }]))).toBe('not_api_owned');
    // Та же ведомость, загруженная в ФОТ под другим ГУИДом: отмена по ГУИДу 1С её не находит — found: false, суммы на месте.
    const otherGuid = '77777777-7777-4777-8777-777777777777';
    expect((await cancel([{ guid: otherGuid, version: 1 }]))[0]).toMatchObject({ action: 'cancelled', found: false });
    expect((await sql('SELECT total_amount::text AS total FROM payroll_1c_payout_documents WHERE doc_guid = $1::uuid', [G3]))[0])
      .toEqual({ total: '300.00' });

    // Ведомость из API в обход API не меняется (кнопка, скрипт, ручной SQL).
    await expect(sql(`UPDATE payroll_1c_payout_documents SET comment = 'x' WHERE doc_guid = $1::uuid`, [G1]))
      .rejects.toThrow('пришла из 1С по API');

    // dry-run ничего не пишет; без версии — только dry-run.
    const fresh = xmlDoc({ guid: '44444444-4444-4444-8444-444444444444', number: '0000-003004', lines: [{ name: 'Иванов Иван', amount: '50.00', idFot: 2 }] });
    expect(await codeOf(post(xml(fresh)))).toBe('version_required');
    const before = (await sql('SELECT count(*)::int AS n FROM payroll_1c_payout_documents'))[0].n;
    expect((await post(xml(fresh), true))[0].action).toBe('new');
    expect((await sql('SELECT count(*)::int AS n FROM payroll_1c_payout_documents'))[0].n).toBe(before);

    // Ведомость под блокировкой (кнопка грузит ту же) — 409 busy.
    const holder = await pg.pool!.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_1c_payout:${G1}`]);
      expect(await codeOf(post(xml(xmlDoc({ guid: G1, version: 7, lines: [{ name: 'Иванов Иван', amount: '1.00', idFot: 1 }] }))))).toBe('busy');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
  it('журнал: месяцы, отменённая, ФИО строк, состав; окно сотрудника — ведомость одной строкой', async () => {
    await sql('ALTER TABLE employees ADD COLUMN IF NOT EXISTS full_name text');
    await sql(`UPDATE employees SET full_name = CASE id WHEN 1 THEN 'Иванов Иван Иванович' ELSE 'Петров Пётр' END`);
    const G5 = '55555555-5555-4555-8555-555555555555';
    const G6 = '66666666-6666-4666-8666-666666666666';
    await post(xml(
      xmlDoc({ guid: G5, version: 1, number: '0000-005001', method: 'Премии', month: 12, comment: 'Премия за ноябрь', lines: [
        { name: 'Иванов Иван', amount: '100.00', idFot: 1, basis: 'премия A' },
        { name: 'Иванов Иван', amount: '50.00', idFot: 1, basis: 'премия B' },
        { name: 'Неизвестный Н', amount: '30.00' },
      ] }),
      xmlDoc({ guid: G6, version: 1, number: '0000-005002', method: 'Отпуска', month: 12, lines: [{ name: 'Петров Пётр', amount: '200.00', idFot: 2 }] }),
    ));
    await cancel([{ guid: G6, version: 2 }]);

    const docs = await listPayoutJournal(['2026-12']);
    expect(docs.map(doc => [doc.doc_number, doc.state])).toEqual([['0000-005002', 'cancelled'], ['0000-005001', 'active']]);
    expect(docs[0]).toMatchObject({ total_amount: '200.00', lines: 0, lines_amount: '0', payment_method: 'Отпуска', version: '2', names: '' });
    expect(docs[1]).toMatchObject({
      period_month: '2026-12', organization_inn: '7736255508', total_amount: '180.00', lines_amount: '180.00', lines: 3,
      employees: 1, unmatched_lines: 1, unmatched_amount: '30.00', comment: 'Премия за ноябрь', origin: 'api', version: '1',
    });
    // ФИО строк для поиска на экране: из 1С и сотрудника ФОТ, без повторов.
    expect(docs[1].names.split(' · ').sort()).toEqual(['Иванов Иван', 'Иванов Иван Иванович', 'Неизвестный Н']);
    expect(await listPayoutJournal(['2026-01'])).toEqual([]);

    const card = await getPayoutJournalDoc(docs[1].id);
    expect(card?.lines.map(line => [line.full_name_1c, line.amount, line.employee_name, line.resolution, line.month, line.basis])).toEqual([
      ['Иванов Иван', '100.00', 'Иванов Иван Иванович', 'auto_id_fot', '2026-12', 'премия A'],
      ['Иванов Иван', '50.00', 'Иванов Иван Иванович', 'auto_id_fot', '2026-12', 'премия B'],
      ['Неизвестный Н', '30.00', null, 'unmatched', '2026-12', null],
    ]);
    expect(await getPayoutJournalDoc(999_999)).toBeNull();

    expect(await listEmployeePayouts1c(1, '2026-12', '2026-12')).toEqual([expect.objectContaining({
      month: '2026-12', document_id: docs[1].id, doc_number: '0000-005001', payment_method: 'Премии', amount: '150.00',
      organization_inn: '7736255508', origin: 'api', comment: 'Премия за ноябрь', basis: 'премия A; премия B',
    })]);
    expect(await listEmployeePayouts1c(2, '2026-12', '2026-12')).toEqual([]);
  });
  it('ведомость из файла → под API: решения ФОТ сохраняются, отмена и возврат, откат; по номеру — перенос ведомости в месяц ФОТ', async () => {
    const GF = '88888888-8888-4888-8888-888888888881';
    const docF = (version: number) => xmlDoc({ guid: GF, version, number: '0000-007001', method: 'Отпуска', comment: 'Отпуск', lines: [
      { name: 'Иванов Иван', amount: '100.00' }, { name: 'Пётр Петров', amount: '50.00', idFot: 1 },
    ] });
    const [keyIvanov, keyPetrov] = parsePayout1cApiXml(xml(docF(1)))[0].lines.map(line => line.lineKey);
    const [file] = await sql(`INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, doc_date, period_month, payment_method,
                 organization_inn, total_amount, content_hash, revision, origin)
               VALUES ($1::uuid, '0000-007001', '2026-11-20', '2026-11-01', 'Отпуска', '7736255508', 150, $2, 1, 'file') RETURNING id`, [GF, HASH]);
    // Иванов — сотрудник 2 выбран в ФОТ вручную; Петров — без сотрудника, перенесён в октябрь.
    await sql(`INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, amount, employee_id, resolution,
                 resolution_reason, period_month, period_month_reason)
               VALUES ($1, 1, $2, 'Иванов Иван', 100, 2, 'confirmed', 'выбран вручную', NULL, NULL),
                      ($1, 2, $3, 'Пётр Петров', 50, NULL, 'unmatched', 'нет в ФОТ', '2026-10-01', 'тест: за октябрь')`,
      [file.id, keyIvanov, keyPetrov]);
    const linesF = async () => sql(`SELECT l.full_name_1c, l.employee_id, l.resolution, l.period_month::text AS period_month
                                      FROM payroll_1c_payout_lines l WHERE l.document_id = $1 ORDER BY l.line_no`, [file.id]);
    const expected = [
      { full_name_1c: 'Иванов Иван', employee_id: 2, resolution: 'confirmed', period_month: null },
      { full_name_1c: 'Пётр Петров', employee_id: 1, resolution: 'auto_id_fot', period_month: '2026-10-01' },
    ];

    // dry-run ничего не меняет, запись — adopted: строки из 1С, решения ФОТ на месте, шапка — под API.
    expect((await post(xml(docF(1)), true))[0].action).toBe('adopted');
    expect((await linesF())[0]).toMatchObject({ employee_id: 2, period_month: null });
    expect((await sql('SELECT origin FROM payroll_1c_payout_documents WHERE id = $1', [file.id]))[0].origin).toBe('file');
    const [adopted] = await post(xml(docF(1)));
    expect(adopted).toMatchObject({ action: 'adopted', lines_matched: 2, lines_unmatched: 0 });
    expect(await linesF()).toEqual(expected);
    expect((await sql('SELECT origin, comment FROM payroll_1c_payout_documents WHERE id = $1', [file.id]))[0]).toEqual({ origin: 'api', comment: 'Отпуск' });
    expect(await journal(GF)).toEqual(['adopt']);

    // Отмена из 1С и повторное проведение: решения ФОТ — из снимка отмены.
    await cancel([{ guid: GF, version: 2 }]);
    expect(await linesF()).toEqual([]);
    expect((await post(xml(docF(3))))[0].action).toBe('restore');
    expect(await linesF()).toEqual(expected);

    // По номеру под другим ГУИДом, ведомость перенесена в ФОТ в сентябрь (в 1С — ноябрь): ГУИД из 1С, строки — в сентябре.
    const GFILE = '88888888-8888-4888-8888-888888888882';
    const GAPI = '88888888-8888-4888-8888-888888888883';
    const [moved] = await sql(`INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, doc_date, period_month, payment_method,
                 organization_inn, total_amount, content_hash, revision, origin)
               VALUES ($1::uuid, '0000-007002', '2026-11-20', '2026-09-01', 'Премии', '7736255508', 70, $2, 1, 'file') RETURNING id`, [GFILE, HASH]);
    await sql(`INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, amount, employee_id, resolution)
               VALUES ($1, 1, 'k-old', 'Иванов Иван', 70, 1, 'auto_id_all')`, [moved.id]);
    const [byNumber] = await post(xml(xmlDoc({ guid: GAPI, version: 1, number: '0000-007002', method: 'Премии', lines: [{ name: 'Иванов Иван', amount: '70.00', idFot: 1 }] })));
    expect(byNumber).toMatchObject({ action: 'adopted', differences: ['месяц: в ФОТ 2026-09, из 1С 2026-11'] });
    expect((await sql(`SELECT d.doc_guid::text AS guid, d.period_month::text AS period, l.period_month::text AS line_period, l.employee_id
                         FROM payroll_1c_payout_documents d JOIN payroll_1c_payout_lines l ON l.document_id = d.id WHERE d.id = $1`, [moved.id]))[0])
      .toEqual({ guid: GAPI, period: '2026-11-01', line_period: '2026-09-01', employee_id: 1 });

    // Откат этой выгрузки: прежние ГУИД, origin, месяц и строки; состояния API нет.
    const [batch] = await sql(`SELECT batch_id::text AS id FROM payroll_1c_payout_api_batches ORDER BY received_at DESC, batch_id LIMIT 1`);
    await rollbackPayoutApiBatch({ batchId: batch.id, by: 'Тест', apply: true });
    expect((await sql(`SELECT d.doc_guid::text AS guid, d.origin, d.period_month::text AS period, l.line_key, l.period_month AS line_period
                         FROM payroll_1c_payout_documents d JOIN payroll_1c_payout_lines l ON l.document_id = d.id WHERE d.id = $1`, [moved.id]))[0])
      .toEqual({ guid: GFILE, origin: 'file', period: '2026-09-01', line_key: 'k-old', line_period: null });
    expect(await state(GAPI)).toBeUndefined();
  });

  it('«ЗП к выплате»: снимается зарплатой или премией API, возвращается, когда их не осталось; dry-run и откат', async () => {
    const [toPay] = await sql(`INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, doc_date, period_month, payment_method,
                 organization_inn, total_amount, content_hash, revision, origin)
               VALUES ('99999999-9999-4999-8999-999999999990', '0000000403', '2026-11-12', '2026-10-01', 'Зарплата за месяц',
                       '7736255508', 144980, $1, 1, 'to_pay') RETURNING id`, [HASH]);
    await sql(`INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, amount, employee_id, resolution, resolution_reason)
               VALUES ($1, 1, 'tp-1', 'Иванов Иван', 144880, 1, 'confirmed', 'ЗП к выплате 10.2026 (XML ЗУП2): по коду физлица 1С (id_all)'),
                      ($1, 2, 'tp-2', 'Петров Пётр', 100, 2, 'confirmed', 'ЗП к выплате 10.2026 (XML ЗУП2): по коду физлица 1С (id_all)')`, [toPay.id]);
    const toPayLines = async () => (await sql('SELECT employee_id, amount::text AS amount FROM payroll_1c_payout_lines WHERE document_id = $1 ORDER BY line_no', [toPay.id]));
    const GP = '99999999-9999-4999-8999-999999999991';
    const GS = '99999999-9999-4999-8999-999999999992';
    const premium = (version: number) => xmlDoc({ guid: GP, version, number: '0000-008001', month: 10, method: 'Премии', lines: [{ name: 'Иванов Иван', amount: '97030.00', idFot: 1 }] });
    const salary = (version: number) => xmlDoc({ guid: GS, version, number: '0000-008002', month: 10, method: 'Зарплата за месяц', lines: [{ name: 'Иванов Иван', amount: '47850.00', idFot: 1 }] });

    // dry-run показывает снятие, но ничего не меняет.
    expect((await post(xml(premium(1)), true))[0].warnings).toEqual([expect.stringContaining('снята строка Иванов Иван 144880.00 за 2026-10')]);
    expect(await toPayLines()).toHaveLength(2);
    // Пришла только премия — строка Иванова снята целиком; Петров на месте; повтор ничего не меняет.
    await post(xml(premium(1)));
    expect(await toPayLines()).toEqual([{ employee_id: 2, amount: '100.00' }]);
    expect((await post(xml(premium(1))))[0].action).toBe('unchanged');
    expect((await sql('SELECT count(*)::int AS n FROM payroll_1c_payout_to_pay_superseded'))[0].n).toBe(1);
    // Пришла и зарплата; отмена премии — зарплата ещё есть, строка не возвращается; отмена зарплаты — возвращается.
    await post(xml(salary(1)));
    expect((await cancel([{ guid: GP, version: 2 }]))[0].warnings).toEqual([]);
    expect(await toPayLines()).toEqual([{ employee_id: 2, amount: '100.00' }]);
    expect((await cancel([{ guid: GS, version: 2 }]))[0].warnings).toEqual([expect.stringContaining('возвращена строка Иванов Иван 144880.00')]);
    expect(await toPayLines()).toEqual([{ employee_id: 1, amount: '144880.00' }, { employee_id: 2, amount: '100.00' }]);
    expect((await cancel([{ guid: GS, version: 2 }]))[0].action).toBe('unchanged');
    expect(await toPayLines()).toHaveLength(2);
    // Премия снова (версия 3) — снята; откат этой выгрузки — строка возвращается.
    await post(xml(premium(3)));
    expect(await toPayLines()).toEqual([{ employee_id: 2, amount: '100.00' }]);
    const [batch] = await sql(`SELECT batch_id::text AS id FROM payroll_1c_payout_api_batches ORDER BY received_at DESC, batch_id LIMIT 1`);
    const rolled = await rollbackPayoutApiBatch({ batchId: batch.id, by: 'Тест', apply: true });
    expect(rolled.toPay).toEqual([expect.objectContaining({ action: 'restore', employeeId: 1 })]);
    expect(await toPayLines()).toEqual([{ employee_id: 1, amount: '144880.00' }, { employee_id: 2, amount: '100.00' }]);
    expect((await sql(`SELECT action FROM payroll_1c_payout_imports WHERE document_id = $1 ORDER BY id`, [toPay.id])).map(row => row.action))
      .toEqual(['supersede', 'restore', 'supersede', 'restore']);
  });
});
