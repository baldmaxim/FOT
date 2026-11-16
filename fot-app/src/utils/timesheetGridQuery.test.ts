import { describe, expect, it } from 'vitest';

import { timesheetGridQueryKey } from './timesheetGridQuery';

const base = {
  month: '2026-11', rangeStart: '2026-11-01', rangeEnd: '2026-11-30', departmentKey: 'D1', includeEmpty: true,
};

describe('timesheetGridQueryKey', () => {
  it('с флагом рамок и без — разные ключи', () => {
    expect(timesheetGridQueryKey({ ...base, includeWeekendMissing: true }))
      .not.toEqual(timesheetGridQueryKey({ ...base, includeWeekendMissing: false }));
  });

  it('внутри [\'timesheet-page\']: сбрасывается правками табеля', () => {
    expect(timesheetGridQueryKey({ ...base, includeWeekendMissing: true })[0]).toBe('timesheet-page');
  });
});
