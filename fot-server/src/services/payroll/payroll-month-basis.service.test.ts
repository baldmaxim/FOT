import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { assembleMonthBasis, coversPeriod, type IMonthBasisSource } from './payroll-month-basis.service.js';

const source = (over: Partial<IMonthBasisSource>): IMonthBasisSource => ({
  basisId: 1,
  versionId: 10,
  coverFrom: '2026-09-01',
  coverTo: '2026-09-15',
  normDays: 22,
  normMinutes: 10560,
  workdayDates: [],
  dayoffDates: [],
  absenceDays: {},
  overtimeMinutes: {},
  quality: 'materialized',
  departmentId: 'dept-1',
  isBrigade: false,
  ...over,
});

const september = { from: '2026-09-01', to: '2026-09-30' };

describe('основа месяца из закрытых подач', () => {
  it('две закрытые половины покрывают месяц — дни складываются', () => {
    const basis = assembleMonthBasis([
      source({
        basisId: 2, versionId: 11, coverFrom: '2026-09-16', coverTo: '2026-09-30', workdayDates: ['2026-09-16'],
        overtimeMinutes: { '2026-09-16': 180 },
      }),
      source({ workdayDates: ['2026-09-01'], dayoffDates: ['2026-09-05'], absenceDays: { vacation: 2 } }),
    ], september);
    expect(basis).toEqual({
      state: 'closed',
      quality: 'materialized',
      basisIds: [1, 2],
      versionIds: [10, 11],
      normDays: 22,
      normMinutes: 10560,
      workdayDates: ['2026-09-01', '2026-09-16'],
      dayoffDates: ['2026-09-05'],
      absenceDays: { vacation: 2, sick: 0, educational_leave: 0, unpaid: 0 },
      overtimeMinutes: { '2026-09-16': 180 },
      brigades: [],
    });
  });

  it('дни подач бригады — ещё и по бригадам', () => {
    const basis = assembleMonthBasis([
      source({ departmentId: 'brigade-1', isBrigade: true, workdayDates: ['2026-09-01'], dayoffDates: ['2026-09-06'] }),
      source({ basisId: 2, versionId: 11, coverFrom: '2026-09-16', coverTo: '2026-09-30', workdayDates: ['2026-09-16'] }),
    ], september);
    expect(basis.state === 'closed' && basis.brigades).toEqual([
      { departmentId: 'brigade-1', workdayDates: ['2026-09-01'], dayoffDates: ['2026-09-06'] },
    ]);
  });

  it('вторая половина не закрыта — месяц не закрыт', () => {
    expect(assembleMonthBasis([source({})], september)).toEqual({ state: 'not_closed', reason: 'not_covered' });
    expect(assembleMonthBasis([], september)).toEqual({ state: 'not_closed', reason: 'not_covered' });
  });

  it('принят 20-го — хватает второй половины; дни до приёма не считаются', () => {
    const basis = assembleMonthBasis(
      [source({ coverFrom: '2026-09-16', coverTo: '2026-09-30', workdayDates: ['2026-09-18', '2026-09-21'] })],
      { from: '2026-09-20', to: '2026-09-30' },
    );
    expect(basis.state).toBe('closed');
    expect(basis.state === 'closed' && basis.workdayDates).toEqual(['2026-09-21']);
  });

  it('норма часов половин разошлась — тоже не закрыт', () => {
    const basis = assembleMonthBasis([
      source({}),
      source({ basisId: 2, versionId: 11, coverFrom: '2026-09-16', coverTo: '2026-09-30', normMinutes: 10500 }),
    ], september);
    expect(basis).toEqual({ state: 'not_closed', reason: 'norm_conflict' });
  });

  it('нормы половин разошлись — месяц не закрыт', () => {
    const basis = assembleMonthBasis([
      source({}),
      source({ basisId: 2, versionId: 11, coverFrom: '2026-09-16', coverTo: '2026-09-30', normDays: 23 }),
    ], september);
    expect(basis).toEqual({ state: 'not_closed', reason: 'norm_conflict' });
  });

  it('хоть одна основа дозаполнена — восстановлено по текущим графикам', () => {
    const basis = assembleMonthBasis([
      source({}),
      source({ basisId: 2, versionId: 11, coverFrom: '2026-09-16', coverTo: '2026-09-30', quality: 'reconstructed' }),
    ], september);
    expect(basis.state === 'closed' && basis.quality).toBe('reconstructed');
  });

  it('покрытие: перекрытия и стык дней', () => {
    expect(coversPeriod([
      { coverFrom: '2026-09-01', coverTo: '2026-09-20' },
      { coverFrom: '2026-09-10', coverTo: '2026-09-30' },
    ], september)).toBe(true);
    expect(coversPeriod([
      { coverFrom: '2026-09-01', coverTo: '2026-09-14' },
      { coverFrom: '2026-09-16', coverTo: '2026-09-30' },
    ], september)).toBe(false);
  });
});
