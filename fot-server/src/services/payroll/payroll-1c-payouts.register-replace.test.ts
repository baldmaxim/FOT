import { describe, expect, it } from 'vitest';

import {
  buildReplaceTarget,
  snapshotToInput,
  type IMonthSnapshot,
  type ISnapshotDocRow,
  type ISnapshotLineRow,
} from '../../../scripts/lib/payouts-register-replace.js';
import type { IRegisterSqlDocument, IRegisterSqlLine } from '../../../scripts/lib/payouts-register-sql.js';

// Режим --replace генератора регистра выплат: снимок прода → набор from (только форма загрузки генератором) и
// набор to: оставляемые документы — из снимка, расхождения строк и сопоставления со снимком — стоп.

const MONTH = '2026-09-01';
const lockKey = (docNumber: string, docDate: string) => `payroll_1c_payout_no:${docNumber}|${docDate}`;

const docRow = (guid: string, docNumber: string, total: string, extra: Partial<ISnapshotDocRow> = {}): ISnapshotDocRow => ({
  doc_guid: guid, doc_number: docNumber, zup2_number: null, doc_date: '2026-10-05', period_month: MONTH,
  payment_method: 'Аванс', salary_project: null, organization_inn: '7736255508', total_amount: total,
  content_hash: `${guid.slice(0, 1).repeat(64)}`, revision: 1, updated_by: null, has_journal: false, ...extra,
});
const lineRow = (guid: string, lineNo: number, name: string, amount: string, employeeId: number | null,
  extra: Partial<ISnapshotLineRow> = {}): ISnapshotLineRow => ({
  doc_guid: guid, line_no: lineNo, line_key: `${name.toLowerCase()}|${Math.round(Number(amount) * 100)}|1`,
  full_name_1c: name, person_id_all: null, brigade_1c: 'ИТР', amount, employee_id: employeeId,
  employee_name: employeeId === null ? null : `${name} (ФОТ)`, resolution: employeeId === null ? 'unmatched' : 'confirmed',
  resolution_reason: 'Регистр выплат ЗУП 09.2026: ФИО + подразделение', ...extra,
});

const GA = 'a0000000-0000-5000-8000-000000000001';
const GB = 'b0000000-0000-5000-8000-000000000002';
const GC = 'c0000000-0000-5000-8000-000000000003';

const snapshot = (): IMonthSnapshot => ({
  docs: [docRow(GA, '0000-000001', '300.00'), docRow(GB, '0000-000002', '50.50', { payment_method: 'Премии' })],
  lines: [
    lineRow(GA, 1, 'Иванов Иван', '100.00', 1),
    lineRow(GA, 2, 'Товбин Михаил', '200.00', null),
    lineRow(GB, 1, 'Петров Пётр', '50.50', 2),
  ],
});

/** Документ и строки файла в форме генератора. */
const fileDoc = (guid: string, docNumber: string, method: string, lines: Array<[string, number, number | null]>) => {
  const doc: IRegisterSqlDocument = {
    guid, docNumber, docDate: '2026-10-05', periodMonth: MONTH, paymentMethod: method,
    totalCents: lines.reduce((sum, [, cents]) => sum + cents, 0), contentHash: guid.slice(0, 1).repeat(64),
    lineCount: lines.length, lockKey: lockKey(docNumber, '2026-10-05'),
  };
  const docLines = lines.map(([name, cents, employeeId], index): IRegisterSqlLine => ({
    guid, lineNo: index + 1, lineKey: `${name.toLowerCase()}|${cents}|1`, fullName: name, department: 'ИТР',
    amountCents: cents, employeeId, employeeName: employeeId === null ? null : `${name} (ФОТ)`,
    resolution: employeeId === null ? 'unmatched' : 'confirmed', reason: 'Регистр выплат ЗУП 09.2026: пересчитано',
  }));
  return { doc, lines: docLines };
};

describe('регистр выплат: замена месяца — снимок и набор to', () => {
  it('снимок → from: копейки, lock, сотрудники и причины как в БД', () => {
    const from = snapshotToInput(snapshot(), MONTH, lockKey);
    expect(from.documents.map(doc => [doc.guid, doc.totalCents, doc.lineCount, doc.lockKey])).toEqual([
      [GA, 30000, 2, 'payroll_1c_payout_no:0000-000001|2026-10-05'],
      [GB, 5050, 1, 'payroll_1c_payout_no:0000-000002|2026-10-05'],
    ]);
    expect(from.lines.map(line => [line.lineNo, line.amountCents, line.employeeId, line.resolution])).toEqual([
      [1, 10000, 1, 'confirmed'], [2, 20000, null, 'unmatched'], [1, 5050, 2, 'confirmed'],
    ]);
  });

  it('снимок не в форме загрузки генератором или не сходится — отказ', () => {
    const broken = (patch: (snap: IMonthSnapshot) => void, message: RegExp) => {
      const snap = snapshot();
      patch(snap);
      expect(() => snapshotToInput(snap, MONTH, lockKey)).toThrow(message);
    };
    broken(snap => { snap.docs[0].revision = 2; }, /revision 2/);
    broken(snap => { snap.docs[0].has_journal = true; }, /журнале/);
    broken(snap => { snap.docs[1].zup2_number = '00000777'; }, /не этим скриптом/);
    broken(snap => { snap.docs[1].updated_by = '00000000-0000-0000-0000-0000000000aa'; }, /не этим скриптом/);
    broken(snap => { snap.lines[0].person_id_all = '00000000-0000-0000-0000-000000000001'; }, /id_all/);
    broken(snap => { snap.lines[0].amount = '100.01'; }, /в шапке 300/);
    broken(snap => { snap.lines[1].resolution = 'confirmed'; }, /сотрудник ≠ resolution/);
    broken(snap => { snap.lines[2].resolution_reason = ' '; }, /нет причины/);
    broken(snap => { snap.lines[2].employee_name = null; }, /не найден/);
    broken(snap => { snap.docs[0].total_amount = '300'; }, /не NUMERIC/);
  });

  it('оставлен (ГУИД + хеш) — строки из снимка; нет в файле — удалён; нет в снимке — добавлен', () => {
    const from = snapshotToInput(snapshot(), MONTH, lockKey);
    // В файле строки оставляемого документа в другом порядке (второй формат ЗУП без «НомерСтроки») — не расхождение.
    const a = fileDoc(GA, '0000-000001', 'Аванс', [['Товбин Михаил', 20000, null], ['Иванов Иван', 10000, 1]]);
    const c = fileDoc(GC, '0000-000788', 'Премии', [['Петров Пётр', 7000, 2], ['Новый Нов', 100, 9]]);
    const target = buildReplaceTarget(from, [a.doc, c.doc], [...a.lines, ...c.lines]);
    expect(target.kept.map(doc => doc.guid)).toEqual([GA]);
    expect(target.removed.map(doc => doc.guid)).toEqual([GB]);
    expect(target.added.map(doc => doc.guid)).toEqual([GC]);
    expect(target.to.documents.map(doc => doc.guid)).toEqual([GA, GC]);
    // Оставленный — причины из снимка, не пересчитанные.
    expect(target.to.lines.filter(line => line.guid === GA).map(line => [line.lineNo, line.fullName, line.reason])).toEqual([
      [1, 'Иванов Иван', 'Регистр выплат ЗУП 09.2026: ФИО + подразделение'],
      [2, 'Товбин Михаил', 'Регистр выплат ЗУП 09.2026: ФИО + подразделение'],
    ]);
    expect(target.to.lines.filter(line => line.guid === GC)).toEqual(c.lines);
  });

  it('стоп: у оставляемого документа другой сотрудник или строка; у добавленного — не тот, что в загрузке', () => {
    const from = snapshotToInput(snapshot(), MONTH, lockKey);
    const otherEmployee = fileDoc(GA, '0000-000001', 'Аванс', [['Иванов Иван', 10000, 7], ['Товбин Михаил', 20000, null]]);
    expect(() => buildReplaceTarget(from, [otherEmployee.doc], otherEmployee.lines)).toThrow(/строка 1: сотрудник 1 → 7/);
    const otherBrigade = fileDoc(GA, '0000-000001', 'Аванс', [['Иванов Иван', 10000, 1], ['Товбин Михаил', 20000, null]]);
    otherBrigade.lines[0].department = 'бр.Другая';
    expect(() => buildReplaceTarget(from, [otherBrigade.doc], otherBrigade.lines)).toThrow(/строка 1: подразделение/);
    const otherSum = fileDoc(GA, '0000-000001', 'Аванс', [['Иванов Иван', 10001, 1], ['Товбин Михаил', 19999, null]]);
    expect(() => buildReplaceTarget(from, [otherSum.doc], otherSum.lines)).toThrow(/ФИО или суммы нет в загруженной/);
    const premium = fileDoc(GC, '0000-000788', 'Премии', [['Товбин Михаил', 500, 5]]);
    expect(() => buildReplaceTarget(from, [premium.doc], premium.lines)).toThrow(/в загрузке — —/);
  });
});
