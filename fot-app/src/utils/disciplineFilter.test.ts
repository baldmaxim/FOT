import { describe, expect, it } from 'vitest';
import { filterDisciplineEmployees } from './disciplineFilter';

// Те же случаи — в fot-server/src/services/discipline-export-filter.service.test.ts: выгрузка = экран.
const PEOPLE = [
  { name: 'Гринёв Андрей', departmentId: 'd1' },
  { name: 'Гриневич Олег', departmentId: 'd2' },
  { name: 'Петров Пётр', departmentId: 'd1' },
];
const names = (rows: Array<{ name: string }>) => rows.map(row => row.name);

describe('filterDisciplineEmployees', () => {
  it('отделы и ФИО: ё = е, раскладка', () => {
    expect(names(filterDisciplineEmployees(PEOPLE, null, 'uhbyt'))).toEqual(['Гринёв Андрей', 'Гриневич Олег']);
    expect(names(filterDisciplineEmployees(PEOPLE, new Set(['d1']), 'грине'))).toEqual(['Гринёв Андрей']);
  });

  it('точный только в другом отделе — в выбранном ищется с одной ошибкой', () => {
    expect(names(filterDisciplineEmployees(PEOPLE, new Set(['d1']), 'гриневич'))).toEqual([]);
    expect(names(filterDisciplineEmployees(PEOPLE, new Set(['d1']), 'петрав'))).toEqual(['Петров Пётр']);
  });

  it('пустой поиск — все из отделов', () => {
    expect(names(filterDisciplineEmployees(PEOPLE, new Set(['d2']), ' '))).toEqual(['Гриневич Олег']);
  });
});
