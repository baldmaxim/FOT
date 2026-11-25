import { describe, expect, it } from 'vitest';

import {
  carryFotDecisions,
  compareForeignPayout,
  decidePayoutCancel,
  decidePayoutPost,
  payoutApiHash,
  type IStoredPayoutDoc,
} from './payroll-1c-payouts.api.rules.js';

// Ведомости по API: матрица версий (как у увольнений), отмена и надгробие, владение, «денежное ядро», хеш содержимого.

const apiDoc = (over: Partial<IStoredPayoutDoc> = {}): IStoredPayoutDoc => ({
  id: 7, guid: 'g', origin: 'api', totalCents: 150000, paymentMethod: 'Аванс', periodMonth: '2026-11-01', lines: 2, ...over,
});
const active = (version: number, apiHash = 'h1') => ({ version, state: 'active' as const, apiHash, documentId: 7 });
const cancelled = (version: number) => ({ version, state: 'cancelled' as const, apiHash: 'h1', documentId: 7 });

describe('payroll-1c-payouts.api.rules', () => {
  it('приём: stale / unchanged / revision_conflict / новая / замена / возврат после отмены', () => {
    const post = (state: ReturnType<typeof active> | ReturnType<typeof cancelled> | undefined, version: number | null, apiHash: string,
      byGuid: IStoredPayoutDoc | null = apiDoc()) => decidePayoutPost({ state, version, apiHash, byGuid, byNumber: null });
    expect(post(active(3), 2, 'h1')).toEqual({ kind: 'skip', action: 'stale' });
    expect(post(active(3), 3, 'h1')).toEqual({ kind: 'skip', action: 'unchanged' });
    expect(post(active(3), 3, 'h2')).toMatchObject({ kind: 'conflict', code: 'revision_conflict' });
    expect(post(active(3), 4, 'h2')).toEqual({ kind: 'apply', action: 'replace' });
    expect(post(active(3), 4, 'h1')).toEqual({ kind: 'apply', action: 'unchanged' });
    expect(post(undefined, 1, 'h1', null)).toEqual({ kind: 'apply', action: 'new' });
    // Отмена версии 5: ведомость с версией ≤ 5 не действует, 6 — возвращается (строк нет — restore).
    expect(post(cancelled(5), 5, 'h1', apiDoc({ lines: 0 }))).toEqual({ kind: 'skip', action: 'stale' });
    expect(post(cancelled(5), 4, 'h1', apiDoc({ lines: 0 }))).toEqual({ kind: 'skip', action: 'stale' });
    expect(post(cancelled(5), 6, 'h1', apiDoc({ lines: 0 }))).toEqual({ kind: 'apply', action: 'restore' });
    // Надгробие без документа — новая версия создаёт ведомость.
    expect(post({ version: 5, state: 'cancelled', apiHash: null, documentId: null }, 6, 'h1', null)).toEqual({ kind: 'apply', action: 'new' });
    // Без версии (dry_run) — как новее сохранённой.
    expect(post(active(3), null, 'h2')).toEqual({ kind: 'apply', action: 'replace' });
  });

  it('приём: ведомость из файла — под API (adopt) по ГУИДу и по номеру; бригады и «ЗП к выплате» — «чужие»; тот же номер из API — конфликт', () => {
    const file = apiDoc({ origin: 'file' });
    expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: file, byNumber: null }))
      .toEqual({ kind: 'apply', action: 'adopt', stored: file });
    expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: null, byNumber: file }))
      .toEqual({ kind: 'apply', action: 'adopt', stored: file });
    for (const origin of ['brigade_sheet', 'to_pay']) {
      const other = apiDoc({ origin });
      expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: other, byNumber: null })).toEqual({ kind: 'foreign', stored: other });
      expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: null, byNumber: other })).toEqual({ kind: 'foreign', stored: other });
    }
    expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: null, byNumber: apiDoc() }))
      .toMatchObject({ kind: 'conflict', code: 'duplicate_conflict' });
    // ГУИД — у одной ведомости, номер и дата — у другой: конфликт (запись нарушила бы уникальность); у бригады — «чужая».
    const other = apiDoc({ id: 8, origin: 'file' });
    expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: file, byNumber: other }))
      .toMatchObject({ kind: 'conflict', code: 'duplicate_conflict' });
    expect(decidePayoutPost({ state: active(3), version: 4, apiHash: 'h2', byGuid: apiDoc(), byNumber: other }))
      .toMatchObject({ kind: 'conflict', code: 'duplicate_conflict' });
    const brigade = apiDoc({ origin: 'brigade_sheet' });
    expect(decidePayoutPost({ state: undefined, version: 1, apiHash: 'h', byGuid: brigade, byNumber: other })).toEqual({ kind: 'foreign', stored: brigade });
    // Отмена до приёма (надгробие) — старая версия не оживляет, новая — забирает ведомость файла.
    const tomb = { version: 5, state: 'cancelled' as const, apiHash: null, documentId: null };
    expect(decidePayoutPost({ state: tomb, version: 5, apiHash: 'h', byGuid: null, byNumber: file })).toEqual({ kind: 'skip', action: 'stale' });
    expect(decidePayoutPost({ state: tomb, version: 6, apiHash: 'h', byGuid: null, byNumber: file })).toMatchObject({ action: 'adopt' });
  });

  it('отмена: надгробие, stale, повтор, конфликт версии, не своя ведомость', () => {
    expect(decidePayoutCancel({ state: undefined, version: 5, byGuid: null })).toEqual({ kind: 'apply' });
    expect(decidePayoutCancel({ state: active(3), version: 2, byGuid: apiDoc() })).toEqual({ kind: 'skip', action: 'stale' });
    expect(decidePayoutCancel({ state: active(3), version: 3, byGuid: apiDoc() })).toMatchObject({ kind: 'conflict', code: 'revision_conflict' });
    expect(decidePayoutCancel({ state: active(3), version: 4, byGuid: apiDoc() })).toEqual({ kind: 'apply' });
    expect(decidePayoutCancel({ state: cancelled(4), version: 4, byGuid: apiDoc() })).toEqual({ kind: 'skip', action: 'unchanged' });
    expect(decidePayoutCancel({ state: undefined, version: 9, byGuid: apiDoc({ origin: 'brigade_sheet' }) }))
      .toMatchObject({ kind: 'conflict', code: 'not_api_owned' });
    expect(decidePayoutCancel({ state: undefined, version: 9, byGuid: apiDoc({ origin: 'to_pay' }) }))
      .toMatchObject({ kind: 'conflict', code: 'not_api_owned' });
    // Ведомость из файла до приёма по API из 1С не отменяется.
    expect(decidePayoutCancel({ state: undefined, version: 9, byGuid: apiDoc({ origin: 'file' }) }))
      .toMatchObject({ kind: 'conflict', code: 'not_api_owned' });
  });

  it('денежное ядро: итог и вид; месяц и число строк — только отличия', () => {
    const doc = { totalCents: 150000, paymentMethod: 'Аванс', periodMonth: '2026-11-01', lines: [{}, {}] as never[] };
    expect(compareForeignPayout(doc, apiDoc({ origin: 'file' }))).toEqual({ sameMoney: true, differences: [] });
    expect(compareForeignPayout(doc, apiDoc({ origin: 'file', periodMonth: '2026-10-01', lines: 3 }))).toEqual({
      sameMoney: true, differences: ['месяц: в ФОТ 2026-10, из 1С 2026-11', 'строк: в ФОТ 3, из 1С 2'],
    });
    expect(compareForeignPayout(doc, apiDoc({ origin: 'file', totalCents: 150001 })).sameMoney).toBe(false);
    expect(compareForeignPayout(doc, apiDoc({ origin: 'file', paymentMethod: 'Премии' })).sameMoney).toBe(false);
  });

  it('хеш содержимого меняется от комментария, основания, ID_FOT и кода физлица', () => {
    const base = {
      contentHash: 'c', periodMonth: '2026-11-01', comment: null,
      lines: [{ lineNo: 1, lineKey: 'k', fullName: 'И', personIdAll: null, brigade: null, amountCents: 1, idFot: 1, basis: null }],
    };
    const hash = payoutApiHash(base);
    expect(payoutApiHash({ ...base })).toBe(hash);
    expect(payoutApiHash({ ...base, comment: 'Аванс' })).not.toBe(hash);
    expect(payoutApiHash({ ...base, lines: [{ ...base.lines[0], basis: 'отпуск' }] })).not.toBe(hash);
    expect(payoutApiHash({ ...base, lines: [{ ...base.lines[0], idFot: 2 }] })).not.toBe(hash);
    expect(payoutApiHash({ ...base, lines: [{ ...base.lines[0], personIdAll: 'x' }] })).not.toBe(hash);
  });

  it('решения ФОТ при замене: перенос месяца строки и ведомости, сотрудник вручную; ID_FOT главнее; нет пары — предупреждение', () => {
    const old = (over: Record<string, unknown>) => ({
      line_key: 'k', full_name_1c: 'И', amount: '10.00', employee_id: null, resolution: 'unmatched', resolution_reason: null,
      period_month: null, period_month_reason: null, ...over,
    });
    const target = (lineKey: string, amountCents: number, employeeId: number | null, resolution: 'auto_id_fot' | 'unmatched' = 'unmatched') => ({
      lineKey, amountCents, employeeId, resolution, reason: 'API',
    });
    const { lines, warnings } = carryFotDecisions({
      docPeriod: '2026-10-01',
      docMovedTo: null,
      oldLines: [
        old({ line_key: 'a', employee_id: 5, resolution: 'confirmed', resolution_reason: 'выбран вручную', period_month: '2026-09-01', period_month_reason: 'бригада' }),
        old({ line_key: 'b', employee_id: 6, resolution: 'confirmed', resolution_reason: 'вручную' }),
        old({ line_key: 'old-c', amount: '30.00', employee_id: 7, resolution: 'auto_id_all', period_month: '2026-09-01', period_month_reason: 'бригада' }),
        old({ line_key: 'gone', full_name_1c: 'Пётр', amount: '99.00', period_month: '2026-09-01', period_month_reason: 'бригада' }),
      ],
      targets: [target('a', 1000, null), target('b', 2000, 8, 'auto_id_fot'), target('c', 3000, 7, 'auto_id_fot'), target('d', 4000, null)],
    });
    expect(lines.get('a')).toEqual({ employeeId: 5, resolution: 'confirmed', reason: 'выбран вручную', periodMonth: '2026-09-01', periodMonthReason: 'бригада' });
    expect(lines.get('b')).toMatchObject({ employeeId: 8, resolution: 'auto_id_fot', periodMonth: null });
    // Пара по «сотрудник + сумма» (ФИО в 1С записано иначе): перенос месяца остаётся.
    expect(lines.get('c')).toMatchObject({ employeeId: 7, periodMonth: '2026-09-01' });
    expect(lines.get('d')).toMatchObject({ employeeId: null, periodMonth: null });
    expect(warnings).toEqual(['Пётр 99.00: в 1С строки с такой суммой нет — перенос в 2026-09 не применён']);

    // Ведомость целиком перенесена в ФОТ в сентябрь — у всех строк без своего переноса; совпал с периодом 1С — без переноса.
    const moved = carryFotDecisions({ docPeriod: '2026-10-01', docMovedTo: '2026-09-01', oldLines: [], targets: [target('x', 100, 1)] });
    expect(moved.lines.get('x')).toMatchObject({ periodMonth: '2026-09-01', periodMonthReason: expect.stringContaining('в 2026-09 до приёма по API') });
    const same = carryFotDecisions({ docPeriod: '2026-09-01', docMovedTo: null, oldLines: [old({ line_key: 'x', period_month: '2026-09-01', period_month_reason: 'r' })], targets: [target('x', 1000, 1)] });
    expect(same.lines.get('x')).toMatchObject({ periodMonth: null, periodMonthReason: null });
  });
});
