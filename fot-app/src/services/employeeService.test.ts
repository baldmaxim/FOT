import { describe, expect, it } from 'vitest';
import { appendStaffViewParams } from './employeeService';

const build = (params: Parameters<typeof appendStaffViewParams>[1]): URLSearchParams => {
  const qs = new URLSearchParams();
  appendStaffViewParams(qs, params);
  return qs;
};

describe('appendStaffViewParams — columns', () => {
  it('не задан — параметра нет (прежний набор столбцов)', () => {
    expect(build({ status: 'active' }).has('columns')).toBe(false);
  });

  it('пустой список — columns= (только «№», «ФИО», «Признак»)', () => {
    const qs = build({ columns: [] });
    expect(qs.has('columns')).toBe(true);
    expect(qs.get('columns')).toBe('');
    expect(qs.toString()).toBe('columns=');
  });

  it('видимые столбцы — через запятую', () => {
    expect(build({ columns: ['department', 'site', 'comment'] }).get('columns')).toBe('department,site,comment');
  });
});
