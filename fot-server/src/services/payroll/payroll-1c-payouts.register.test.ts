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
}

const row = (r: IRow): unknown[] => [
  r.period ?? SEPT, r.registrar, r.no, r.org ?? 'ООО "СУ-10"', r.name, r.method ?? 'Увольнения', r.employee ?? r.name,
  r.dept ?? 'бр.Гузь В.', 'Заработная плата и иные доходы с ограничением взыскания', r.amount, r.period ?? SEPT,
  'Выплата в межрасчетный период', r.storno ?? 'Нет', r.group ?? 'Выплачено',
];

const sheet = (...rows: IRow[]): unknown[][] => [[...PAYOUTS_REGISTER_HEADER], ...rows.map(row)];

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
