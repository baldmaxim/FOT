import { describe, expect, it } from 'vitest';

import {
  applyManualRules,
  decide,
  parseManualRules,
  type IDecision,
} from '../../../scripts/lib/payouts-person-decision.js';
import {
  buildXmlSqlLines,
  classifyStored,
  moveMarker,
  outputNames,
  parseXmlFiles,
  type IStoredPayoutDoc,
} from '../../../scripts/lib/payouts-xml-files.js';
import { normalizePayoutName } from './payroll-1c-payouts.parser.js';

// Несколько выгрузок ведомостей ЗУП за месяц одним набором (build-payouts-xml-sql.ts): правила набора, перенос месяца
// по списку, сверка с уже загруженным, имена результатов, строки SQL с ручными решениями. Вымышленные данные.

const SM = '7705794997';
const SU10 = '7736255508';

interface IDocOpts { guid: string; number: string; month?: string; inn?: string; day?: string; rows?: Array<[string, string]> }

const docXml = (o: IDocOpts): string => {
  const rows = o.rows ?? [['Иванов Иван', '1 000']];
  const total = rows.reduce((sum, [, amount]) => sum + Number(amount.replace(/\s/g, '').replace(',', '.')), 0);
  return '<документ><имя_док>ВедомостьНаВыплатуЗарплатыВБанк</имя_док>'
    + `<организация_инн>${o.inn ?? SM}</организация_инн><организация_имя>АО "Тест"</организация_имя>`
    + `<Док_Гуид>${o.guid}</Док_Гуид><Док_Номер>${o.number}</Док_Номер>`
    + `<Док_Дата><Год>2026</Год><Мес>10</Мес><День>${o.day ?? '5'}</День></Док_Дата>`
    + `<ПериодРегистрации><Год>2026</Год><Мес>${o.month ?? '9'}</Мес><День>1</День></ПериодРегистрации>`
    + '<ЗарплатныйПроект>Банк</ЗарплатныйПроект><СпособВыплаты>Премии</СпособВыплаты>'
    + `<СуммаПоДокументу>${String(total).replace('.', ',')}</СуммаПоДокументу><Состав/>`
    + `<Зарплата>${rows.map(([name, amount]) => `<расшифровка><ФизЛицо><код>1</код><наименование>${name}</наименование>`
      + `</ФизЛицо><КВыплате>${amount}</КВыплате></расшифровка>`).join('')}`
    + '<расшифровка><ФизЛицо><код>00000</код></ФизЛицо><КВыплате>0</КВыплате></расшифровка></Зарплата>'
    + '<Зарплата_руководство/><Основания><расшифровка><Документ>Премия</Документ></расшифровка></Основания></документ>';
};
const fileOf = (path: string, ...docs: IDocOpts[]) => ({
  path,
  content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><зп_документы_31>'
    + '<имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя><версия>1.0</версия>'
    + `<ЗарплатаКВыплатеОрганизаций>${docs.map(docXml).join('')}</ЗарплатаКВыплатеОрганизаций></зп_документы_31>`),
});

const g = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AVANS = fileOf('/x/аванс.xml', { guid: g(1), number: 'СМЗП-1' }, { guid: g(2), number: 'СМЗП-2' });
const OCT = fileOf('/x/премия 30.10.xml', { guid: g(3), number: 'СМЗП-3', month: '10' });
const NOV = fileOf('/x/премия 16.11.xml', { guid: g(4), number: 'СМЗП-4', month: '11', rows: [['Гриневич Николай', '500'], ['Товбин М', '700']] });

describe('набор файлов ведомостей: правила', () => {
  it('восемь файлов как один набор: перенос распределён по файлам, остальное — свой месяц, файл у каждого документа', () => {
    const set = parseXmlFiles([AVANS, OCT, NOV], '2026-09', ['СМЗП-4', 'СМЗП-3']);
    expect(set.organizationInn).toBe(SM);
    expect(set.sources.map(s => [s.name, s.documents])).toEqual([['аванс.xml', 2], ['премия 30.10.xml', 1], ['премия 16.11.xml', 1]]);
    expect(set.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(set.documents.map(d => [d.docNumber, d.periodMonth, d.sourcePeriodMonth, d.sourceFile])).toEqual([
      ['СМЗП-1', '2026-09-01', null, 'аванс.xml'],
      ['СМЗП-2', '2026-09-01', null, 'аванс.xml'],
      ['СМЗП-3', '2026-09-01', '2026-10-01', 'премия 30.10.xml'],
      ['СМЗП-4', '2026-09-01', '2026-11-01', 'премия 16.11.xml'],
    ]);
    expect(set.moved.map(d => d.docNumber)).toEqual(['СМЗП-3', 'СМЗП-4']);
  });

  it('стоп: повтор --file и --move-doc, ГУИД или номер+дата в двух файлах, две организации', () => {
    expect(() => parseXmlFiles([AVANS, { ...AVANS, path: '/x/../x/аванс.xml' }], '2026-09', [])).toThrow(/указан дважды/);
    expect(() => parseXmlFiles([OCT], '2026-09', ['СМЗП-3', 'СМЗП-3'])).toThrow(/--move-doc «СМЗП-3» указан дважды/);
    expect(() => parseXmlFiles([AVANS, fileOf('/x/b.xml', { guid: g(1), number: 'СМЗП-9' })], '2026-09', []))
      .toThrow(new RegExp(`ГУИД ${g(1)} — в «аванс.xml» и «b.xml»`));
    expect(() => parseXmlFiles([AVANS, fileOf('/x/b.xml', { guid: g(9), number: 'СМЗП-1' })], '2026-09', []))
      .toThrow(/СМЗП-1 от 2026-10-05 — в «аванс.xml» и «b.xml»/);
    expect(() => parseXmlFiles([AVANS, fileOf('/x/b.xml', { guid: g(9), number: '0000-1', inn: SU10 })], '2026-09', []))
      .toThrow(/разных организаций \(ИНН 7705794997, 7736255508\)/);
  });

  it('стоп: --move-doc не использован, номер списка уже за месяц, чужой месяц вне списка (с именем файла)', () => {
    expect(() => parseXmlFiles([AVANS, OCT], '2026-09', ['СМЗП-3', 'СМЗП-4'])).toThrow(/не использован .*: СМЗП-4/);
    expect(() => parseXmlFiles([AVANS], '2026-09', ['СМЗП-1'])).toThrow(/«аванс.xml»: .*в списке переноса, но 1С уже провела её/);
    expect(() => parseXmlFiles([AVANS, OCT], '2026-09', [])).toThrow(/«премия 30.10.xml»: .*месяц начисления 2026-10-01, ожидался 2026-09/);
  });
});

describe('набор файлов ведомостей: сверка с уже загруженным', () => {
  const [, , moved] = parseXmlFiles([AVANS, OCT], '2026-09', ['СМЗП-3']).documents;
  // Та же ведомость в выгрузке своего месяца (октябрь, без переноса) — так её встретит будущая загрузка октября.
  const [ownMonth] = parseXmlFiles([OCT], '2026-10', []).documents;
  const storedRow = (over: Partial<IStoredPayoutDoc> = {}): IStoredPayoutDoc => ({
    doc_guid: g(3), doc_number: 'СМЗП-3', doc_date: '2026-10-05', content_hash: moved.contentHash, period_month: '2026-09-01',
    organization_inn: SM, reasons: [`Выплаченная ЗП 09.2026 (XML ЗУП СМ): один кандидат по ФИО; ${moveMarker('2026-10-01', '2026-09-01')}`],
    ...over,
  });

  it('нет в БД → новая; тот же ГУИД, хеш, ИНН и месяц → «уже загружена» (повтор той же загрузки)', () => {
    expect(classifyStored(moved, [])).toEqual({ status: 'new' });
    expect(classifyStored(moved, [storedRow()])).toEqual({ status: 'loaded' });
    expect(ownMonth.contentHash).toBe(moved.contentHash);
  });

  it('выгрузка своего месяца: перенесённая с маркером → «уже перенесена» (already_moved)', () => {
    expect(classifyStored(ownMonth, [storedRow()])).toEqual({ status: 'already_moved', storedMonth: '2026-09-01' });
  });

  it('стоп: другой хеш, ИНН, нет маркера у строки, номер+дата под другим ГУИДом', () => {
    expect(classifyStored(ownMonth, [storedRow({ content_hash: 'f'.repeat(64) })]).problem).toMatch(/другое содержимое/);
    expect(classifyStored(ownMonth, [storedRow({ organization_inn: SU10 })]).problem).toMatch(/другая организация/);
    expect(classifyStored(ownMonth, [storedRow({ reasons: [...storedRow().reasons, 'без маркера'] })]).problem)
      .toMatch(/за 09\.2026 без отметки переноса/);
    expect(classifyStored(ownMonth, [storedRow({ reasons: [] })]).problem).toMatch(/без отметки переноса/);
    expect(classifyStored(moved, [storedRow({ doc_guid: g(8) })]).problem).toMatch(/уже загружена под другим ГУИДом/);
  });
});

describe('набор файлов ведомостей: имена результатов и строки SQL', () => {
  it('--tag в имени; не латиница или путь — отказ', () => {
    expect(outputNames('2026-09', 'sm', null, null))
      .toEqual({ base: 'payroll-1c-payouts-2026-09-sm', report: 'Перечислено_1С_2026-09_sm_сверка.xlsx' });
    expect(outputNames('2026-09', null, 'premii', 'Премии').base).toBe('payroll-1c-payouts-2026-09-replace-premii');
    for (const tag of ['../x', 'a/b', 'См', '-sm', 'SM']) expect(() => outputNames('2026-09', tag, null, null)).toThrow(/--tag/);
  });

  it('--link и --unmatched меняют строки SQL: сотрудник, resolution, причина; у переноса — маркер', () => {
    const set = parseXmlFiles([AVANS, NOV], '2026-09', ['СМЗП-4']);
    const persons = [...new Set(set.documents.flatMap(d => d.lines.map(l => l.fullName)))]
      .map(name => ({ key: normalizePayoutName(name), fullName: name, idAll: null, autoEmployeeId: null }));
    // Иванов — один кандидат по ФИО, Гриневич и Товбин в ФОТ не нашлись.
    const auto = new Map<string, IDecision>(persons.map(p => [p.key,
      decide(p.fullName === 'Иванов Иван' ? [{ employee_id: 5 } as never] : [], null, new Set(), new Set())]));
    const decisions = applyManualRules(persons, parseManualRules(['Гриневич Николай=481'], ['Товбин М']), auto);
    const lines = buildXmlSqlLines(set.documents, line => decisions.get(normalizePayoutName(line.fullName)) as IDecision,
      id => `ФОТ ${id}`, 'Выплаченная ЗП 09.2026 (XML ЗУП СМ)');
    expect(lines.map(l => [l.fullName, l.employeeId, l.employeeName, l.resolution, l.reason])).toEqual([
      ['Иванов Иван', 5, 'ФОТ 5', 'confirmed', 'Выплаченная ЗП 09.2026 (XML ЗУП СМ): один кандидат по ФИО'],
      ['Иванов Иван', 5, 'ФОТ 5', 'confirmed', 'Выплаченная ЗП 09.2026 (XML ЗУП СМ): один кандидат по ФИО'],
      ['Гриневич Николай', 481, 'ФОТ 481', 'confirmed',
        'Выплаченная ЗП 09.2026 (XML ЗУП СМ): указан при загрузке; ведомость 1С за 11.2026 — в 09.2026 по решению пользователя'],
      ['Товбин М', null, null, 'unmatched',
        'Выплаченная ЗП 09.2026 (XML ЗУП СМ): без сотрудника по решению; ведомость 1С за 11.2026 — в 09.2026 по решению пользователя'],
    ]);
  });
});

describe('набор файлов: выгрузка «ЗП к выплате» (ЗУП_ВЫПЛАТЫ)', () => {
  const TO_PAY = {
    path: '/x/заОктябрь 2026.xml',
    content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><ЗУП_ВЫПЛАТЫ><имя>данные_из_зуп_зп_к_выплате</имя><Документ>'
      + `<гуид>${g(20)}</гуид><док_ном>0000000403</док_ном><док_дата>12.11.2026 16:30:32</док_дата>`
      + '<период_регистрации>01.10.2026 0:00:00</период_регистрации><строки><строка><фио>Тестов Тест</фио>'
      + `<id_all>${g(21)}</id_all><сумма>87 000</сумма><ндфл>13 000</ндфл><кНачислению>100 000</кНачислению></строка>`
      + '</строки></Документ></ЗУП_ВЫПЛАТЫ>'),
  };
  const OPTIONS = { paymentMethod: 'Зарплата за месяц', organizationInn: SU10 };

  it('вид — по корню и «имя» (не по имени файла): разбор «ЗП к выплате», вид и ИНН из параметров', () => {
    const set = parseXmlFiles([{ ...TO_PAY, path: '/x/выплаченная ЗП.xml' }], '2026-10', [], OPTIONS);
    expect(set.kind).toBe('to_pay');
    expect(set.organizationInn).toBe(SU10);
    expect(set.documents.map(d => [d.docNumber, d.paymentMethod, d.totalCents, d.sourceFile])).toEqual([
      ['0000000403', 'Зарплата за месяц', 8_700_000, 'выплаченная ЗП.xml'],
    ]);
    expect(parseXmlFiles([AVANS], '2026-09', []).kind).toBe('zup_month');
  });

  it('стоп: «ЗП к выплате» без вида и ИНН; две выгрузки в одном наборе', () => {
    expect(() => parseXmlFiles([TO_PAY], '2026-10', [])).toThrow(/«заОктябрь 2026.xml»: .*нужны вид выплаты и ИНН/);
    expect(() => parseXmlFiles([TO_PAY, fileOf('/x/b.xml', { guid: g(9), number: '0000-1', inn: SU10, month: '10' })], '2026-10', [], OPTIONS))
      .toThrow(/разные выгрузки в одном наборе: ведомости ЗУП \(b.xml\) и «ЗП к выплате» \(заОктябрь 2026.xml\)/);
  });
});
