import { describe, expect, it } from 'vitest';

import { buildPayoutLineKeys } from './payroll-1c-payouts.parser.js';
import {
  buildRegisterDocuments,
  PAYOUTS_REGISTER_HEADER,
  PayoutsRegisterError,
  registerAmountCents,
  registerDocGuid,
} from './payroll-1c-payouts.register.js';

const SEPT = '01.09.2026 0:00:00';

interface IRow {
  registrar: string;
  no: number;
  name: string;
  method?: string;
  dept?: string;
  amount: unknown;
  employee?: string;
  org?: string;
  storno?: string;
  group?: string;
  period?: string;
  /** «Период» (месяц регистрации), если отличается от ПериодВзаиморасчетов. */
  registered?: string;
  kind?: string;
}

const row = (r: IRow): unknown[] => [
  r.registered ?? r.period ?? SEPT, r.registrar, r.no, r.org ?? 'ООО "СУ-10"', r.name, r.method ?? 'Увольнения',
  r.employee ?? r.name, r.dept ?? 'бр.Гузь В.', 'Заработная плата и иные доходы с ограничением взыскания', r.amount,
  r.period ?? SEPT, r.kind ?? 'Выплата в межрасчетный период', r.storno ?? 'Нет', r.group ?? 'Выплачено',
];

const sheet = (...rows: IRow[]): unknown[][] => [[...PAYOUTS_REGISTER_HEADER], ...rows.map(row)];

/** Второй формат ЗУП: без «НомерСтроки», «Сторно», «Группа…», со «Статьями»; `no` не выгружается. */
const V2_HEADER = [
  'Период', 'Регистратор', 'Организация', 'ФизическоеЛицо', 'РегистраторСпособВыплаты', 'СтатьяФинансирования',
  'СтатьяРасходов', 'Сотрудник', 'Подразделение', 'СуммаВзаиморасчетов', 'ПериодВзаиморасчетов', 'ВидВзаиморасчетов',
];
const rowV2 = (r: IRow): unknown[] => [
  r.registered ?? r.period ?? SEPT, r.registrar, r.org ?? 'ООО "СУ-10"', r.name, r.method ?? 'Увольнения', null, 'ОТ',
  r.employee ?? r.name, r.dept ?? 'бр.Гузь В.', r.amount, r.period ?? SEPT, r.kind ?? 'Выплата в межрасчетный период',
];
const sheetV2 = (...rows: IRow[]): unknown[][] => [V2_HEADER, ...rows.map(rowV2)];

const B2644 = 'Ведомость в банк 0000-002644 от 09.10.2026';
const B2526 = 'Ведомость в банк 0000-002526 от 05.10.2026';

describe('регистр выплат ЗУП → ведомости', () => {
  it('ГУИД — UUID v5 от «номер|дата» в постоянном пространстве имён (golden)', () => {
    expect(registerDocGuid('0000-002644', '2026-10-09')).toBe('4ebbcc40-d6b9-53fa-8158-f1925ca23212');
    expect(registerDocGuid('0000-002309', '2026-09-01')).toBe('bf19fdd8-8d5c-5c48-b617-9ade2c0fc0ff');
    expect(registerDocGuid('0000-002526', '2026-10-05')).toBe('785e53ef-438d-5cf7-9eaf-8c2e6eb2474b');
  });

  it('ведомость = регистратор: номер, дата, способ, месяц, строки по «НомерСтроки», ключи как у XML', () => {
    const [doc] = buildRegisterDocuments(sheet(
      { registrar: B2644, no: 2, name: 'Тажиев Иззатилла Икрамович', amount: 31818.18, dept: 'бр.Асланов А.Т.' },
      { registrar: B2644, no: 1, name: 'Алимов Абдуманноп Одил Угли', amount: 43500 },
    ), '2026-09');
    expect(doc).toMatchObject({
      guid: '4ebbcc40-d6b9-53fa-8158-f1925ca23212', docNumber: '0000-002644', docDate: '2026-10-09',
      periodMonth: '2026-09-01', paymentMethod: 'Увольнения', totalCents: 7531818,
    });
    expect(doc.lines.map(line => [line.lineNo, line.fullName, line.department, line.amountCents, line.sourceRows])).toEqual([
      [1, 'Алимов Абдуманноп Одил Угли', 'бр.Гузь В.', 4350000, [1]],
      [2, 'Тажиев Иззатилла Икрамович', 'бр.Асланов А.Т.', 3181818, [2]],
    ]);
    expect(doc.lines.map(line => line.lineKey)).toEqual(buildPayoutLineKeys(doc.lines));
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('зачёт: строки человека с минусом сворачиваются в одну; повтор без минуса — две строки', () => {
    const [doc] = buildRegisterDocuments(sheet(
      { registrar: B2526, no: 378, name: 'Разаханова Марина Аллахяровна', method: 'Аванс', amount: -100000 },
      { registrar: B2526, no: 379, name: 'Разаханова Марина Аллахяровна', method: 'Аванс', amount: 300000 },
      { registrar: B2526, no: 380, name: 'Пулатов Аскар Тиничбаевич', method: 'Аванс', amount: 10000 },
      { registrar: B2526, no: 381, name: 'Пулатов Аскар Тиничбаевич', method: 'Аванс', amount: 10000 },
    ), '2026-09');
    expect(doc.lines.map(line => [line.fullName, line.amountCents, line.sourceRows])).toEqual([
      ['Разаханова Марина Аллахяровна', 20000000, [378, 379]],
      ['Пулатов Аскар Тиничбаевич', 1000000, [380]],
      ['Пулатов Аскар Тиничбаевич', 1000000, [381]],
    ]);
    expect(doc.lines.map(line => line.lineKey.split('|').at(-1))).toEqual(['1', '1', '2']);
    expect(doc.totalCents).toBe(22000000);
  });

  it('ведомости — по дате и номеру; хвостовой пробел и регистр в ФИО Сотрудника не мешают', () => {
    const docs = buildRegisterDocuments(sheet(
      { registrar: B2644, no: 1, name: 'Кастро Дмитрий Фреди ', employee: 'Кастро Дмитрий Фреди', amount: 1 },
      { registrar: B2526, no: 1, name: 'Рузибаев Норкул Ххх', employee: 'Рузибаев Норкул ХХХ', method: 'Аванс', amount: 2 },
    ), '2026-09');
    expect(docs.map(doc => doc.docNumber)).toEqual(['0000-002526', '0000-002644']);
    expect(docs[1].lines[0].fullName).toBe('Кастро Дмитрий Фреди');
  });

  it('второй формат: без «НомерСтроки» — по порядку в файле; «Премия» с «Периодом» следующего месяца', () => {
    const docs = buildRegisterDocuments(sheetV2(
      { registrar: 'Премия 0000-000788 от 05.10.2026', no: 0, name: 'Тюрин Дмитрий Юрьевич', method: 'Премии',
        amount: 107230, registered: '01.10.2026 0:00:00', dept: 'ИТР' },
      { registrar: B2644, no: 0, name: 'Алимов Абдуманноп Одил Угли', amount: 43500 },
      { registrar: 'Премия 0000-000788 от 05.10.2026', no: 0, name: 'Балбашиоглу Эмре', method: 'Премии',
        amount: 672000, registered: '01.10.2026 0:00:00', dept: 'ИТР' },
    ), '2026-09');
    expect(docs.map(doc => [doc.registrar, doc.docNumber, doc.docDate, doc.periodMonth, doc.paymentMethod, doc.totalCents]))
      .toEqual([
        ['Премия 0000-000788 от 05.10.2026', '0000-000788', '2026-10-05', '2026-09-01', 'Премии', 77923000],
        [B2644, '0000-002644', '2026-10-09', '2026-09-01', 'Увольнения', 4350000],
      ]);
    expect(docs[0].guid).toBe(registerDocGuid('0000-000788', '2026-10-05'));
    expect(docs[0].lines.map(line => [line.lineNo, line.fullName, line.sourceRows])).toEqual([
      [1, 'Тюрин Дмитрий Юрьевич', [1]],
      [2, 'Балбашиоглу Эмре', [2]],
    ]);
  });

  it('одна ведомость в обоих форматах и с переставленными столбцами — те же строки и contentHash', () => {
    const rows: IRow[] = [
      { registrar: B2526, no: 1, name: 'Разаханова Марина Аллахяровна', method: 'Аванс', amount: -100000 },
      { registrar: B2526, no: 2, name: 'Разаханова Марина Аллахяровна', method: 'Аванс', amount: 300000 },
      { registrar: B2526, no: 3, name: 'Пулатов Аскар Тиничбаевич', method: 'Аванс', amount: 10000, dept: 'бр.Пулатов' },
      { registrar: B2526, no: 4, name: 'Пулатов Аскар Тиничбаевич', method: 'Аванс', amount: 10000, dept: 'бр.Пулатов' },
    ];
    const v1 = buildRegisterDocuments(sheet(...rows), '2026-09');
    const v2 = buildRegisterDocuments(sheetV2(...rows), '2026-09');
    const permuted = sheetV2(...rows).map(cells => [...cells].reverse());
    expect(v2).toEqual(v1);
    expect(buildRegisterDocuments(permuted, '2026-09')).toEqual(v1);
    expect(v1[0].lines).toHaveLength(3);
  });

  it('отказ (второй формат): чужой или повторный столбец, вид не «Выплата…», «Период» раньше месяца', () => {
    const okV2: IRow = { registrar: B2644, no: 0, name: 'Алимов А.А.', amount: 100 };
    const rejectsV2 = (data: unknown[][], message: RegExp) => {
      expect(() => buildRegisterDocuments(data, '2026-09')).toThrow(PayoutsRegisterError);
      expect(() => buildRegisterDocuments(data, '2026-09')).toThrow(message);
    };
    rejectsV2([[...V2_HEADER, 'Лишний'], [...rowV2(okV2), 'x']], /Заголовок/);
    rejectsV2([[...V2_HEADER, 'СтатьяРасходов'], [...rowV2(okV2), 'ОТ']], /Заголовок/);
    rejectsV2(sheetV2({ ...okV2, kind: 'Начисление зарплаты' }), /не выплата/);
    rejectsV2(sheetV2({ ...okV2, registered: '01.08.2026 0:00:00' }), /«Период» раньше 2026-09/);
    rejectsV2(sheetV2({ ...okV2, period: '01.10.2026 0:00:00' }), /«ПериодВзаиморасчетов» не 2026-09/);
  });

  const rejects = (rows: IRow[], message: RegExp) => {
    expect(() => buildRegisterDocuments(sheet(...rows), '2026-09')).toThrow(PayoutsRegisterError);
    expect(() => buildRegisterDocuments(sheet(...rows), '2026-09')).toThrow(message);
  };
  const ok: IRow = { registrar: B2644, no: 1, name: 'Алимов А.А.', amount: 100 };

  it('отказ: другой месяц, организация, сторно, группа, формат регистратора', () => {
    rejects([{ ...ok, period: '01.08.2026 0:00:00' }], /не 2026-09/);
    rejects([{ ...ok, org: 'ООО "ФОРТЭКС"' }], /другая организация/);
    rejects([{ ...ok, storno: 'Да' }], /сторно/);
    rejects([{ ...ok, group: 'Начислено' }], /группа/);
    rejects([{ ...ok, registrar: 'Касса 0000-000001 от 01.10.2026' }], /формат не поддержан/);
    rejects([{ ...ok, registrar: 'Ведомость в банк 0000-000001 от 31.02.2026' }], /дата/);
  });

  it('отказ: ФИО ≠ Сотрудник, разные способы, повтор строки, номер и дата у двух регистраторов', () => {
    rejects([{ ...ok, employee: 'Другой Д.Д.' }], /≠ Сотрудник/);
    rejects([ok, { ...ok, no: 2, name: 'Б Б.Б.', method: 'Аванс' }], /несколько способов/);
    rejects([ok, { ...ok, name: 'Б Б.Б.' }], /НомерСтроки повторяется/);
    rejects([ok, { ...ok, registrar: 'Ведомость на счета 0000-002644 от 09.10.2026' }], /Номер и дата совпали/);
  });

  it('отказ: итог зачёта ≤ 0, сумма не число, лишние знаки, ноль; чужой заголовок', () => {
    rejects([{ ...ok, amount: -100 }, { ...ok, no: 2, amount: 100 }], /не больше нуля/);
    rejects([{ ...ok, amount: '100,00' }], /не число/);
    rejects([{ ...ok, amount: 0 }], /нулевая/);
    expect(() => registerAmountCents(10.005, 'x')).toThrow(/больше двух знаков/);
    expect(registerAmountCents(31818.18, 'x')).toBe(3181818);
    expect(registerAmountCents(-21750, 'x')).toBe(-2175000);
    expect(() => buildRegisterDocuments([['Период', 'Регистратор'], row(ok)], '2026-09')).toThrow(/Заголовок/);
    expect(() => buildRegisterDocuments(sheet(), '2026-09')).toThrow(/нет строк/);
  });
});
