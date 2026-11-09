import { describe, expect, it } from 'vitest';

import {
  PAYROLL_GROUP_OPTIONS,
  payrollGroupOfValue,
  payrollGroupValue,
  pickDepartmentOrGroup,
} from './payrollDepartmentGroups';

describe('группы отделов «Расчётов»', () => {
  it('два пункта списка: ИТР (с бывшим «Офисом»), Рабочие', () => {
    expect(PAYROLL_GROUP_OPTIONS.map(option => option.label)).toEqual(['ИТР', 'Рабочие']);
    expect(PAYROLL_GROUP_OPTIONS.map(option => payrollGroupOfValue(option.value))).toEqual(['itr', 'worker']);
  });

  it('id отдела и «Все отделы» — не группа', () => {
    expect(payrollGroupOfValue('2cd8a403-6454-408b-9c2b-8a2db65c7511')).toBeNull();
    expect(payrollGroupOfValue('')).toBeNull();
    expect(payrollGroupOfValue('group:boss')).toBeNull();
    expect(payrollGroupOfValue('group:office')).toBeNull();
  });

  it('группа снимает отдел, отдел — группу, «Все отделы» — оба', () => {
    expect(pickDepartmentOrGroup(payrollGroupValue('worker'))).toEqual({ group: 'worker', departmentId: '' });
    expect(pickDepartmentOrGroup('dept-1')).toEqual({ group: null, departmentId: 'dept-1' });
    expect(pickDepartmentOrGroup('')).toEqual({ group: null, departmentId: '' });
  });
});
