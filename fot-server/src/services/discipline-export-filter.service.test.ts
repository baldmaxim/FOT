import { describe, expect, it } from 'vitest';
import { filterDisciplineEmployeeSummaries } from './discipline-export-filter.service.js';
import type { DisciplineExportEmployeeSummary } from './skud-export.service.js';

// Те же случаи — в fot-app/src/utils/disciplineFilter.test.ts: выгрузка = экран.
const person = (name: string, departmentId: string, late = 0): DisciplineExportEmployeeSummary => ({
  name, departmentId, late, total: late,
} as unknown as DisciplineExportEmployeeSummary);
const PEOPLE = [person('Гринёв Андрей', 'd1', 2), person('Гриневич Олег', 'd2'), person('Петров Пётр', 'd1')];
const names = (rows: DisciplineExportEmployeeSummary[]) => rows.map(row => row.name);
const filter = (departmentIds: string[], searchQuery: string, extra: { onlyViolations?: boolean } = {}) =>
  filterDisciplineEmployeeSummaries(PEOPLE, { departmentIds, searchQuery, activeTab: 'all', onlyViolations: extra.onlyViolations ?? false });

describe('filterDisciplineEmployeeSummaries', () => {
  it('отделы и ФИО: ё = е, раскладка', () => {
    expect(names(filter([], 'uhbyt'))).toEqual(['Гринёв Андрей', 'Гриневич Олег']);
    expect(names(filter(['d1'], 'грине'))).toEqual(['Гринёв Андрей']);
  });

  it('точный только в другом отделе — в выбранном ищется с одной ошибкой', () => {
    expect(names(filter(['d1'], 'гриневич'))).toEqual([]);
    expect(names(filter(['d1'], 'петрав'))).toEqual(['Петров Пётр']);
  });

  it('пустой поиск — все из отделов', () => {
    expect(names(filter(['d2'], ' '))).toEqual(['Гриневич Олег']);
  });

  it('«только с нарушениями» — вид поверх найденных, режим поиска не меняет', () => {
    expect(names(filter([], 'петров', { onlyViolations: true }))).toEqual([]);
  });
});
