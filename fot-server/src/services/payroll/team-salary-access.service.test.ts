import { describe, expect, it } from 'vitest';

import { resolveReleasedSalaryMonth } from './team-salary-access.service.js';

/**
 * Месяц столбца «Зарплата» (миграция 382, решение пользователя 27.11.2026): всегда прошлый; с 10-го числа по МСК —
 * месяц−1, до 10-го — месяц−2. Прод в UTC: 00:00 МСК 10-го — это 21:00 UTC 9-го.
 */
describe('resolveReleasedSalaryMonth', () => {
  it('27.11 — октябрь, переход 10.12 в 00:00 МСК', () => {
    expect(resolveReleasedSalaryMonth(new Date('2026-11-27T09:00:00Z'))).toEqual({
      month: '2026-10',
      next_from: '2026-12-09T21:00:00.000Z',
    });
  });

  it('за секунду до 00:00 МСК 10.12 — ещё октябрь, смена в 10.12', () => {
    expect(resolveReleasedSalaryMonth(new Date('2026-12-09T20:59:59Z'))).toEqual({
      month: '2026-10',
      next_from: '2026-12-09T21:00:00.000Z',
    });
  });

  it('ровно 00:00 МСК 10.12 — ноябрь, следующая смена 10.01', () => {
    expect(resolveReleasedSalaryMonth(new Date('2026-12-09T21:00:00Z'))).toEqual({
      month: '2026-11',
      next_from: '2027-01-09T21:00:00.000Z',
    });
  });

  it('до 10-го — месяц−2, смена 10-го текущего месяца; через год', () => {
    expect(resolveReleasedSalaryMonth(new Date('2027-01-05T10:00:00Z'))).toEqual({
      month: '2026-11',
      next_from: '2027-01-09T21:00:00.000Z',
    });
    expect(resolveReleasedSalaryMonth(new Date('2027-02-01T10:00:00Z'))).toEqual({
      month: '2026-12',
      next_from: '2027-02-09T21:00:00.000Z',
    });
  });

  it('с 10-го января — декабрь прошлого года, смена 10.02', () => {
    expect(resolveReleasedSalaryMonth(new Date('2027-01-10T10:00:00Z'))).toEqual({
      month: '2026-12',
      next_from: '2027-02-09T21:00:00.000Z',
    });
  });

  it('1-е число по МСК при 31-м по UTC (21:30 UTC) — уже новый месяц МСК', () => {
    // 01.12 00:30 МСК: день < 10 → октябрь (месяц−2), смена 10.12.
    expect(resolveReleasedSalaryMonth(new Date('2026-11-30T21:30:00Z'))).toEqual({
      month: '2026-10',
      next_from: '2026-12-09T21:00:00.000Z',
    });
  });

  it('декабрь с 10-го — ноябрь, смена 10.01 следующего года', () => {
    expect(resolveReleasedSalaryMonth(new Date('2026-12-31T20:00:00Z')).next_from).toBe('2027-01-09T21:00:00.000Z');
  });
});
