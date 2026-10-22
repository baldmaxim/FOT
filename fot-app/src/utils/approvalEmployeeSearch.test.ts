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
  const APPROVALS = [
    { id: 10, employees: EMPLOYEES.slice(0, 2) },
    { id: 20, employees: EMPLOYEES.slice(2) },
    { id: 30 },
  ];
  const ids = (query: string) => [...matchApprovalEmployees(APPROVALS, query)]
    .map(([approvalId, matches]) => [approvalId, matches.map(e => e.employee_id)]);

  it('пустой или пробельный запрос — поиск выключен', () => {
    expect(matchApprovalEmployees(APPROVALS, '').size).toBe(0);
    expect(matchApprovalEmployees(APPROVALS, '   ').size).toBe(0);
  });

  it('часть фамилии без учёта регистра', () => {
    expect(ids('андру')).toEqual([[10, [1]]]);
  });

  it('ё и е взаимозаменяемы в обе стороны; английская раскладка', () => {
    expect(ids('королев')).toEqual([[10, [2]]]);
    expect(ids('Пётровна')).toEqual([[20, [3]]]);
    expect(ids('rjhjktd')).toEqual([[10, [2]]]);
  });

  it('подстрока в имени/отчестве и несколько совпадений', () => {
    expect(ids('петр')).toEqual([[10, [2]], [20, [3]]]);
    expect(ids('алина серг')).toEqual([[10, [1]]]);
  });

  it('одна ошибка — только если точных нет ни в одной подаче', () => {
    expect(ids('андрсевич')).toEqual([[10, [1]]]);
    expect(ids('иванова')).toEqual([[20, [3]]]);
  });

  it('нет совпадений и нет состава', () => {
    expect(ids('сидоров')).toEqual([]);
    expect(matchApprovalEmployees([{ id: 30 }], 'андру').size).toBe(0);
  });
});
