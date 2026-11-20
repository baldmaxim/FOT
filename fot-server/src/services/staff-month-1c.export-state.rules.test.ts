import { describe, expect, it } from 'vitest';

import {
  checkStaffMonthAck,
  nextStaffMonthRevisions,
  staffMonthExportState,
  staffMonthRowHash,
  type IStaffMonthState,
} from './staff-month-1c.export-state.rules.js';
import { isStaffMonthNightRun, staffMonthRefreshMonths } from './staff-month-1c.scheduler.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const state = (over: Partial<IStaffMonthState>): IStaffMonthState => ({
  revision: 1, present: true, preliminary: false, contentHash: A, ...over,
});

describe('staff-month-1c.export-state.rules', () => {
  it('хеш строки не зависит от порядка ключей и меняется от часов дня', () => {
    const left = staffMonthRowHash({ employee_id: 1, hours: 8, days: [{ date: '2026-10-01', hours: 8 }] });
    const right = staffMonthRowHash({ days: [{ hours: 8, date: '2026-10-01' }], hours: 8, employee_id: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(staffMonthRowHash({ employee_id: 1, hours: 8, days: [{ date: '2026-10-01', hours: 7.5 }] })).not.toBe(left);
  });

  it('ревизии: одинаковая пересборка — без новой, изменение — +1, пропал — надгробие, вернулся — новая', () => {
    const current = new Map([[1, state({})], [2, state({ revision: 4 })]]);
    expect(nextStaffMonthRevisions(current, [
      { employeeId: 1, preliminary: false, contentHash: A },
      { employeeId: 2, preliminary: false, contentHash: A },
    ]).size).toBe(0);
    const next = nextStaffMonthRevisions(current, [
      { employeeId: 1, preliminary: false, contentHash: B },
      { employeeId: 3, preliminary: true, contentHash: A },
    ]);
    expect(next.get(1)).toEqual({ revision: 2, present: true, preliminary: false, contentHash: B });
    expect(next.get(2)).toEqual({ revision: 5, present: false, preliminary: false, contentHash: null });
    expect(next.get(3)).toEqual({ revision: 1, present: true, preliminary: true, contentHash: A });
    const back = nextStaffMonthRevisions(new Map([[2, next.get(2)!]]), [{ employeeId: 2, preliminary: false, contentHash: A }]);
    expect(back.get(2)).toEqual({ revision: 6, present: true, preliminary: false, contentHash: A });
  });

  it('A → B → A: возврат к A — новая ревизия, старый ACK A её не закрывает', () => {
    const revA1 = state({ revision: 1, contentHash: A });
    const revB = nextStaffMonthRevisions(new Map([[7, revA1]]), [{ employeeId: 7, preliminary: false, contentHash: B }]).get(7)!;
    const revA3 = nextStaffMonthRevisions(new Map([[7, revB]]), [{ employeeId: 7, preliminary: false, contentHash: A }]).get(7)!;
    expect(revA3.revision).toBe(3);
    expect(staffMonthExportState(revA3, { revision: 1, ackedAt: 't', documentRef: null })).toBe('changed');
    expect(staffMonthExportState(revA3, { revision: 3, ackedAt: 't', documentRef: null })).toBe('exported');
  });

  it('статусы: не готов, готов, выгружен, изменён, надгробие', () => {
    expect(staffMonthExportState(undefined, undefined)).toBeNull();
    expect(staffMonthExportState(state({ preliminary: true }), undefined)).toBe('not_ready');
    expect(staffMonthExportState(state({ preliminary: true }), { revision: 1, ackedAt: 't', documentRef: null })).toBe('not_ready');
    expect(staffMonthExportState(state({}), undefined)).toBe('ready');
    expect(staffMonthExportState(state({ revision: 2 }), { revision: 2, ackedAt: 't', documentRef: 'ЗУП-1' })).toBe('exported');
    expect(staffMonthExportState(state({ revision: 3 }), { revision: 2, ackedAt: 't', documentRef: null })).toBe('changed');
    const tombstone = state({ revision: 4, present: false, contentHash: null });
    expect(staffMonthExportState(tombstone, undefined)).toBeNull();
    expect(staffMonthExportState(tombstone, { revision: 3, ackedAt: 't', documentRef: null })).toBe('changed');
    expect(staffMonthExportState(tombstone, { revision: 4, ackedAt: 't', documentRef: null })).toBeNull();
  });

  it('ACK: нет ревизии, другой хеш, предварительная, надгробие', () => {
    expect(checkStaffMonthAck(undefined, A)).toBe('not_found');
    expect(checkStaffMonthAck(state({}), B)).toBe('hash_mismatch');
    expect(checkStaffMonthAck(state({ preliminary: true }), A)).toBe('not_ready');
    expect(checkStaffMonthAck(state({}), A)).toBeNull();
    expect(checkStaffMonthAck(state({ present: false, contentHash: null }), null)).toBeNull();
    expect(checkStaffMonthAck(state({ present: false, contentHash: null }), A)).toBe('hash_mismatch');
  });

  it('планировщик: прошлый и текущий месяц по Москве, ночной прогон раз в сутки с 04:00', () => {
    expect(staffMonthRefreshMonths(new Date('2026-11-20T10:00:00Z'))).toEqual(['2026-10', '2026-11']);
    expect(staffMonthRefreshMonths(new Date('2027-01-05T10:00:00Z'))).toEqual(['2026-12', '2027-01']);
    // 31.10 22:30 UTC — уже 1 ноября по Москве.
    expect(staffMonthRefreshMonths(new Date('2026-10-31T22:30:00Z'))).toEqual(['2026-10', '2026-11']);
    expect(staffMonthRefreshMonths(new Date('2026-06-10T10:00:00Z'))).toEqual(['2026-06']);
    expect(isStaffMonthNightRun(new Date('2026-11-20T00:30:00Z'), null)).toBe(false); // 03:30 МСК
    expect(isStaffMonthNightRun(new Date('2026-11-20T01:30:00Z'), null)).toBe(true); // 04:30 МСК
    expect(isStaffMonthNightRun(new Date('2026-11-20T09:00:00Z'), '2026-11-20')).toBe(false);
  });
});
