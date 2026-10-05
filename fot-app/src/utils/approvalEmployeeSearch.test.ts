import { describe, expect, it } from 'vitest';
import { matchApprovalEmployees, normalizeFio } from './approvalEmployeeSearch';

const EMPLOYEES = [
  { employee_id: 1, full_name: 'Андрусевич Алина Сергеевна' },
  { employee_id: 2, full_name: 'Королёв Пётр Иванович' },
  { employee_id: 3, full_name: 'Иванова Мария Петровна' },
];

describe('normalizeFio', () => {
  it('регистр, ё и лишние пробелы', () => {
    expect(normalizeFio('  КОРОЛЁВ   Пётр ')).toBe('королев петр');
  });
});

describe('matchApprovalEmployees', () => {
  it('пустой или пробельный запрос — поиск выключен', () => {
    expect(matchApprovalEmployees(EMPLOYEES, '')).toEqual([]);
    expect(matchApprovalEmployees(EMPLOYEES, '   ')).toEqual([]);
  });

  it('часть фамилии без учёта регистра', () => {
    expect(matchApprovalEmployees(EMPLOYEES, 'андру').map(e => e.employee_id)).toEqual([1]);
  });

  it('ё и е взаимозаменяемы в обе стороны', () => {
    expect(matchApprovalEmployees(EMPLOYEES, 'королев').map(e => e.employee_id)).toEqual([2]);
    expect(matchApprovalEmployees(EMPLOYEES, 'Пётровна').map(e => e.employee_id)).toEqual([3]);
  });

  it('подстрока в имени/отчестве и несколько совпадений', () => {
    expect(matchApprovalEmployees(EMPLOYEES, 'петр').map(e => e.employee_id)).toEqual([2, 3]);
    expect(matchApprovalEmployees(EMPLOYEES, 'алина серг').map(e => e.employee_id)).toEqual([1]);
  });

  it('нет совпадений и нет состава', () => {
    expect(matchApprovalEmployees(EMPLOYEES, 'сидоров')).toEqual([]);
    expect(matchApprovalEmployees(undefined, 'андру')).toEqual([]);
  });
});
