import { describe, expect, it } from 'vitest';
import { collectDepartmentIdsCoveringRange } from './timesheetApprovedCoverage';

const MONTH = { startDate: '2026-09-01', endDate: '2026-09-30' };
const item = (department_id: string | null, start_date: string, end_date: string) => ({
  department_id, start_date, end_date,
});

describe('collectDepartmentIdsCoveringRange', () => {
  it('две половины месяца покрывают месяц', () => {
    const result = collectDepartmentIdsCoveringRange([
      item('a', '2026-09-16', '2026-09-30'),
      item('a', '2026-09-01', '2026-09-15'),
    ], MONTH);

    expect([...result]).toEqual(['a']);
  });

  it('одна подача «весь месяц» покрывает месяц', () => {
    expect([...collectDepartmentIdsCoveringRange([item('a', '2026-09-01', '2026-09-30')], MONTH)]).toEqual(['a']);
  });

  it('одной половины мало', () => {
    expect(collectDepartmentIdsCoveringRange([item('a', '2026-09-01', '2026-09-15')], MONTH).size).toBe(0);
    expect(collectDepartmentIdsCoveringRange([item('a', '2026-09-16', '2026-09-30')], MONTH).size).toBe(0);
  });

  it('дыра между подачами — не покрыт', () => {
    const result = collectDepartmentIdsCoveringRange([
      item('a', '2026-09-01', '2026-09-14'),
      item('a', '2026-09-16', '2026-09-30'),
    ], MONTH);

    expect(result.size).toBe(0);
  });

  it('подачи других месяцев и персональные не учитываются', () => {
    const result = collectDepartmentIdsCoveringRange([
      item('a', '2026-08-01', '2026-08-31'),
      item('a', '2026-10-01', '2026-10-15'),
      item(null, '2026-09-01', '2026-09-30'),
      item('b', '2026-09-01', '2026-09-15'),
      item('b', '2026-09-16', '2026-09-30'),
    ], MONTH);

    expect([...result]).toEqual(['b']);
  });

  it('диапазон-полупериод по-прежнему находится точной подачей', () => {
    const half = { startDate: '2026-09-01', endDate: '2026-09-15' };

    expect([...collectDepartmentIdsCoveringRange([item('a', '2026-09-01', '2026-09-15')], half)]).toEqual(['a']);
    expect(collectDepartmentIdsCoveringRange([item('a', '2026-09-16', '2026-09-30')], half).size).toBe(0);
  });
});
