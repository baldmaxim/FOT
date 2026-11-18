import { describe, expect, it } from 'vitest';

import { buildPayoutLineKeys, payoutContentHash } from './payroll-1c-payouts.parser.js';
import { detectPayoutXmlKind, parsePayout1cToPayXml } from './payroll-1c-payouts.to-pay-xml.js';

// Выгрузка ЗУП2 «ЗП к выплате» (ЗУП_ВЫПЛАТЫ / данные_из_зуп_зп_к_выплате) → документы «Перечислено (1С)» для генератора
// build-payouts-xml-sql.ts. Вымышленные ФИО и коды.

const SU10 = '7736255508';
const SM = '7705794997';
const OPTIONS = { paymentMethod: 'Зарплата за месяц', organizationInn: SU10 };
const ID1 = '61253CC5-E50C-11E0-97CE-000C29BD07FC';
const ID2 = '6e5c134e-e50c-11e0-97ce-000c29bd07fc';

interface ILine { fio?: string; idAll?: string | null; sum?: string; tax?: string; accrued?: string; extra?: string }
interface IDoc { guid?: string; number?: string; date?: string; period?: string; lines?: ILine[]; extra?: string }

const lineXml = (l: ILine): string => '<строка>'
  + `${l.fio === undefined ? '<фио>Тестов Тест Тестович</фио>' : `<фио>${l.fio}</фио>`}`
  + `${l.idAll === null ? '' : `<id_all>${l.idAll ?? ID1}</id_all>`}`
  + `<сумма>${l.sum ?? '250 305'}</сумма><ндфл>${l.tax ?? '37 402'}</ндфл><кНачислению>${l.accrued ?? '287 707'}</кНачислению>`
  + `${l.extra ?? ''}</строка>`;

const docXml = (d: IDoc = {}): string => '<Документ>'
  + `<гуид>${d.guid ?? '46d11ca3-de9d-11f1-966d-0050568674f6'}</гуид><док_ном>${d.number ?? '0000000403'}</док_ном>`
  + `<док_дата>${d.date ?? '12.11.2026 16:30:32'}</док_дата>`
  + `<период_регистрации>${d.period ?? '01.10.2026 0:00:00'}</период_регистрации>`
  + `<строки>${(d.lines ?? [{}]).map(lineXml).join('')}</строки>${d.extra ?? ''}</Документ>`;

const fileXml = (docs: string[] = [docXml()], name = 'данные_из_зуп_зп_к_выплате', root = 'ЗУП_ВЫПЛАТЫ'): string => (
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- edited with XMLSPY v2004 rel. 3 U -->\n'
  + `<${root} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="">`
  + `<имя>${name}</имя>${docs.join('')}</${root}>`
);

const parse = (xml: string, month = '2026-10', options = OPTIONS) => parsePayout1cToPayXml(xml, month, options);

describe('«ЗП к выплате»: разбор', () => {
  it('документ как в образце 1С: все поля, итог — сумма строк, вид и ИНН — из параметров, ключи и хеш — как у кнопки', () => {
    const [doc] = parse(fileXml([docXml({
      lines: [{}, { fio: 'Второв Второй', idAll: ID2, sum: '62 281', tax: '9 306', accrued: '71 587' }],
    })]));
    expect(doc).toMatchObject({
      format: 'zup2',
      guid: '46d11ca3-de9d-11f1-966d-0050568674f6',
      docNumber: '0000000403',
      zup2Number: null,
      docDate: '2026-11-12',
      periodMonth: '2026-10-01',
      paymentMethod: 'Зарплата за месяц',
      salaryProject: null,
      organizationInn: SU10,
      totalCents: 31_258_600,
      docKind: 'данные_из_зуп_зп_к_выплате',
      fileTotalCents: 31_258_600,
      duplicateCents: 0,
      leadershipLines: 0,
      sourcePeriodMonth: null,
    });
    expect(doc.lines).toEqual([
      { lineNo: 1, fullName: 'Тестов Тест Тестович', personIdAll: ID1.toLowerCase(), brigade: null, amountCents: 25_030_500,
        lineKey: 'тестов тест тестович|25030500|1' },
      { lineNo: 2, fullName: 'Второв Второй', personIdAll: ID2, brigade: null, amountCents: 6_228_100,
        lineKey: 'второв второй|6228100|1' },
    ]);
    const keys = buildPayoutLineKeys(doc.lines);
    expect(doc.contentHash).toBe(payoutContentHash({ ...doc, lineKeys: keys }));
  });

  it('NBSP, копейки, дата без времени; СМ принимается', () => {
    const [doc] = parse(fileXml([docXml({ date: '5.11.2026', lines: [{ sum: '1 000,50', tax: '149,50', accrued: '1 150' }] })]),
      '2026-10', { paymentMethod: 'Премии', organizationInn: SM });
    expect(doc.lines[0].amountCents).toBe(100_050);
    expect(doc.docDate).toBe('2026-11-05');
    expect(doc.organizationInn).toBe(SM);
  });

  it('несколько документов; строка без id_all — без кода (сопоставит генератор, никто)', () => {
    const docs = parse(fileXml([
      docXml(),
      docXml({ guid: '46d11ca3-de9d-11f1-966d-0050568674f7', number: '0000000404', lines: [{ idAll: null }] }),
    ]));
    expect(docs.map(d => d.docNumber)).toEqual(['0000000403', '0000000404']);
    expect(docs[1].lines[0].personIdAll).toBeNull();
  });

  it('вид выгрузки — по корню и «имя», не по имени файла', () => {
    expect(detectPayoutXmlKind(fileXml())).toBe('to_pay');
    expect(detectPayoutXmlKind(fileXml([docXml()], 'ВыплатаЗПнаЛС'))).toBe('zup_month');
    expect(detectPayoutXmlKind(fileXml([docXml()], 'данные_из_зуп_зп_к_выплате', 'зп_документы_31'))).toBe('zup_month');
  });
});

describe('«ЗП к выплате»: стоп', () => {
  it('чужое «имя», корень, неизвестный тег документа и строки', () => {
    expect(() => parse(fileXml([docXml()], 'ВыплатаЗПнаЛС'))).toThrow(/не выгрузка «ЗП к выплате»/);
    expect(() => parse(fileXml([docXml()], 'данные_из_зуп_зп_к_выплате', 'зп_документы_31'))).toThrow(/Нужен один корень «ЗУП_ВЫПЛАТЫ»/);
    expect(() => parse(fileXml([docXml({ extra: '<сумма_документа>1</сумма_документа>' })]))).toThrow(/неизвестный раздел «сумма_документа»/);
    expect(() => parse(fileXml([docXml({ lines: [{ extra: '<бригада>1</бригада>' }] })]))).toThrow(/строка 1: неизвестный раздел «бригада»/);
  });

  it('сумма: пустая, 0, отрицательная, ≠ кНачислению − ндфл', () => {
    expect(() => parse(fileXml([docXml({ lines: [{ sum: '' }] })]))).toThrow(/нет «сумма»/);
    expect(() => parse(fileXml([docXml({ lines: [{ sum: '0', tax: '0', accrued: '0' }] })]))).toThrow(/больше нуля/);
    expect(() => parse(fileXml([docXml({ lines: [{ sum: '-5', tax: '0', accrued: '-5' }] })]))).toThrow(/не распознана/);
    expect(() => parse(fileXml([docXml({ lines: [{ sum: '250 306' }] })]))).toThrow(/сумма 250306 ≠ кНачислению 287707 − ндфл 37402/);
  });

  it('невалидный id_all, нет ФИО', () => {
    expect(() => parse(fileXml([docXml({ lines: [{ idAll: 'не-гуид' }] })]))).toThrow(/ГУИД «не-гуид» не распознан/);
    expect(() => parse(fileXml([docXml({ lines: [{ fio: '' }] })]))).toThrow(/нет «фио»/);
  });

  it('несуществующая дата, период не первым числом и не тот месяц', () => {
    expect(() => parse(fileXml([docXml({ date: '31.11.2026 0:00:00' })]))).toThrow(/«док_дата» «31.11.2026 0:00:00» — несуществующая дата/);
    expect(() => parse(fileXml([docXml({ date: '2026-11-12' })]))).toThrow(/— не дата/);
    expect(() => parse(fileXml([docXml({ period: '02.10.2026 0:00:00' })]))).toThrow(/не первое число месяца/);
    expect(() => parse(fileXml([docXml({ period: '01.09.2026 0:00:00' })]))).toThrow(/месяц начисления 2026-09-01, ожидался 2026-10/);
  });

  it('повтор ГУИДа; повтор пары номер + дата (тот же номер другой датой — допустим)', () => {
    expect(() => parse(fileXml([docXml(), docXml({ number: '0000000404' })]))).toThrow(/ГУИД 46d11ca3-de9d-11f1-966d-0050568674f6 повторяется/);
    expect(() => parse(fileXml([docXml(), docXml({ guid: '46d11ca3-de9d-11f1-966d-0050568674f7' })])))
      .toThrow(/Документ 0000000403 от 2026-11-12 повторяется/);
    expect(parse(fileXml([docXml(), docXml({ guid: '46d11ca3-de9d-11f1-966d-0050568674f7', date: '13.11.2026 9:00:00' })])))
      .toHaveLength(2);
  });

  it('нет документов или строк; вид выплаты и ИНН — проверены', () => {
    expect(() => parse(fileXml([]))).toThrow(/нет документов/);
    expect(() => parse(fileXml([docXml({ lines: [] })]))).toThrow(/нет строк/);
    expect(() => parse(fileXml(), '2026-10', { paymentMethod: ' ', organizationInn: SU10 })).toThrow(/Вид выплаты/);
    expect(() => parse(fileXml(), '2026-10', { paymentMethod: 'Зарплата за месяц', organizationInn: '1234567890' }))
      .toThrow(/ИНН 1234567890 не из принимаемых/);
  });
});
