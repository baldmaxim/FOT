import { describe, it, expect, vi } from 'vitest';
import {
  buildExportTree,
  countTreeEmployees,
  DIRECT_REPORTS_GROUP_NAME,
  NO_DEPARTMENT_GROUP_NAME,
  type IExportDepartmentRow,
  type IExportEmployeeRow,
  type IExportNode,
} from './employees-export.service.js';

const dept = (
  id: string,
  name: string,
  parent_id: string | null = null,
  sort_order = 0,
): IExportDepartmentRow => ({ id, name, parent_id, sort_order });

const emp = (id: number, full_name: string, org_department_id: string | null): IExportEmployeeRow =>
  ({ id, full_name, org_department_id });

/** Плоский список всех узлов дерева. */
const flatten = (nodes: IExportNode[]): IExportNode[] =>
  nodes.flatMap(node => [node, ...flatten(node.children)]);

const findNode = (nodes: IExportNode[], name: string): IExportNode | undefined =>
  flatten(nodes).find(node => node.name === name);

/** Все id сотрудников в дереве, с повторами — для проверки «никто не задвоился». */
const collectEmployeeIds = (nodes: IExportNode[]): number[] =>
  flatten(nodes).flatMap(node => node.employees.map(employee => employee.id));

describe('buildExportTree', () => {
  it('строит уровни компания → отдел → бригада и считает total по поддереву', () => {
    const departments = [
      dept('company', 'СУ-10'),
      dept('dept', 'Отдел вентиляции', 'company'),
      dept('brigade', 'бр.Иванов', 'dept'),
    ];
    const employees = [
      emp(1, 'Петров П. П.', 'dept'),
      emp(2, 'Сидоров С. С.', 'brigade'),
      emp(3, 'Абрамов А. А.', 'brigade'),
    ];

    const roots = buildExportTree({ employees, departments });

    expect(roots).toHaveLength(1);
    const company = roots[0];
    expect(company.depth).toBe(0);
    expect(company.total).toBe(3);
    expect(company.ownCount).toBe(0);

    const department = company.children[0];
    expect(department.depth).toBe(1);
    expect(department.total).toBe(3);
    expect(department.ownCount).toBe(1);

    const brigade = department.children[0];
    expect(brigade.depth).toBe(2);
    expect(brigade.total).toBe(2);
    expect(brigade.ownCount).toBe(2);
    expect(countTreeEmployees(roots)).toBe(3);
  });

  it('не выводит подразделения без сотрудников, включая вложенные', () => {
    const departments = [
      dept('company', 'СУ-10'),
      dept('full', 'Отдел с людьми', 'company'),
      dept('empty', 'Пустой отдел', 'company'),
      dept('empty-child', 'Пустая бригада', 'empty'),
    ];
    const employees = [emp(1, 'Петров П. П.', 'full')];

    const roots = buildExportTree({ employees, departments });

    expect(findNode(roots, 'Отдел с людьми')).toBeDefined();
    expect(findNode(roots, 'Пустой отдел')).toBeUndefined();
    expect(findNode(roots, 'Пустая бригада')).toBeUndefined();
  });

  it('оставляет промежуточный узел без своих людей, если поддерево непустое', () => {
    const departments = [
      dept('company', 'СУ-10'),
      dept('middle', 'Участок', 'company'),
      dept('brigade', 'бр.Иванов', 'middle'),
    ];
    const roots = buildExportTree({ employees: [emp(1, 'Петров П. П.', 'brigade')], departments });

    const middle = findNode(roots, 'Участок');
    expect(middle?.ownCount).toBe(0);
    expect(middle?.total).toBe(1);
  });

  it('сортирует сиблингов по имени, когда sort_order одинаковый', () => {
    const departments = [
      dept('root', 'Компания'),
      dept('b', 'Яблоко', 'root', 0),
      dept('a', 'Ёлка', 'root', 0),
      dept('c', 'Берёза', 'root', 0),
    ];
    const employees = [
      emp(1, 'Первый', 'a'),
      emp(2, 'Второй', 'b'),
      emp(3, 'Третий', 'c'),
    ];

    const roots = buildExportTree({ employees, departments });

    expect(roots[0].children.map(node => node.name)).toEqual(['Берёза', 'Ёлка', 'Яблоко']);
  });

  it('sort_order важнее имени', () => {
    const departments = [
      dept('root', 'Компания'),
      dept('a', 'Ёлка', 'root', 5),
      dept('b', 'Яблоко', 'root', 1),
    ];
    const employees = [emp(1, 'Первый', 'a'), emp(2, 'Второй', 'b')];

    const roots = buildExportTree({ employees, departments });

    expect(roots[0].children.map(node => node.name)).toEqual(['Яблоко', 'Ёлка']);
  });

  it('сортирует сотрудников внутри узла по ФИО', () => {
    const departments = [dept('root', 'Компания')];
    const employees = [
      emp(1, 'Яковлев Я. Я.', 'root'),
      emp(2, 'Абрамов А. А.', 'root'),
      emp(3, 'Ёлкин Ё. Ё.', 'root'),
    ];

    const roots = buildExportTree({ employees, departments });

    expect(roots[0].employees.map(employee => employee.full_name))
      .toEqual(['Абрамов А. А.', 'Ёлкин Ё. Ё.', 'Яковлев Я. Я.']);
  });

  it('сотрудники без отдела и с несуществующим отделом уходят в «Без подразделения»', () => {
    const departments = [dept('root', 'Компания')];
    const employees = [
      emp(1, 'Петров П. П.', 'root'),
      emp(2, 'Ничейный Н. Н.', null),
      emp(3, 'Потерянный П. П.', 'departed-dept'),
    ];

    const roots = buildExportTree({ employees, departments });

    const orphans = roots[roots.length - 1];
    expect(orphans.name).toBe(NO_DEPARTMENT_GROUP_NAME);
    expect(orphans.id).toBeNull();
    expect(orphans.employees.map(employee => employee.id)).toEqual([2, 3]);
  });

  it('отдел с несуществующим parent_id становится корнем, сотрудники не теряются', () => {
    const departments = [
      dept('root', 'Компания'),
      dept('orphan', 'Осиротевший отдел', 'missing-parent'),
    ];
    const employees = [emp(1, 'Петров П. П.', 'root'), emp(2, 'Сидоров С. С.', 'orphan')];

    const roots = buildExportTree({ employees, departments });

    const orphan = findNode(roots, 'Осиротевший отдел');
    expect(orphan?.depth).toBe(0);
    expect(collectEmployeeIds(roots).sort()).toEqual([1, 2]);
  });

  it('цикл parent_id не вешает сборку и не теряет сотрудников', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const departments = [
      dept('a', 'Отдел А', 'b'),
      dept('b', 'Отдел Б', 'a'),
    ];
    const employees = [emp(1, 'Петров П. П.', 'a'), emp(2, 'Сидоров С. С.', 'b')];

    const roots = buildExportTree({ employees, departments });

    expect(collectEmployeeIds(roots).sort()).toEqual([1, 2]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('неактивный отдел с людьми остаётся в выгрузке', () => {
    const departments = [dept('root', 'Компания'), dept('legacy', 'Старый отдел', 'root')];
    const roots = buildExportTree({ employees: [emp(1, 'Петров П. П.', 'legacy')], departments });

    expect(findNode(roots, 'Старый отдел')?.total).toBe(1);
  });

  it('подчинённый из отдела вне скоупа уходит в отдельную группу без чужой ветки', () => {
    const departments = [
      dept('mine', 'Мой отдел'),
      dept('foreign-root', 'Чужая компания'),
      dept('foreign', 'Чужой отдел', 'foreign-root'),
    ];
    const employees = [
      emp(1, 'Петров П. П.', 'mine'),
      emp(2, 'Подчинённый П. П.', 'foreign'),
    ];

    const roots = buildExportTree({ employees, departments, scopeDepartmentIds: ['mine'] });

    expect(findNode(roots, 'Чужой отдел')).toBeUndefined();
    expect(findNode(roots, 'Чужая компания')).toBeUndefined();
    const directGroup = findNode(roots, DIRECT_REPORTS_GROUP_NAME);
    expect(directGroup?.employees.map(employee => employee.id)).toEqual([2]);
  });

  it('технический корень «Объект» не выводится, компании поднимаются наверх', () => {
    const departments: IExportDepartmentRow[] = [
      { id: 'root', name: 'Объект', parent_id: null, sort_order: 0, kind: 'object' },
      { id: 'company', name: 'СУ-10', parent_id: 'root', sort_order: 0, kind: 'department' },
      { id: 'dept', name: 'Отдел вентиляции', parent_id: 'company', sort_order: 0, kind: 'department' },
    ];
    const employees = [emp(1, 'Петров П. П.', 'dept')];

    const roots = buildExportTree({ employees, departments });

    expect(roots.map(node => node.name)).toEqual(['СУ-10']);
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children[0].depth).toBe(1);
    expect(countTreeEmployees(roots)).toBe(1);
  });

  it('обычный корень без kind=object остаётся в выгрузке', () => {
    const departments: IExportDepartmentRow[] = [
      { id: 'company', name: 'СУ-10', parent_id: null, sort_order: 0, kind: 'department' },
    ];

    const roots = buildExportTree({ employees: [emp(1, 'Петров П. П.', 'company')], departments });

    expect(roots.map(node => node.name)).toEqual(['СУ-10']);
  });

  it('каждый сотрудник появляется в дереве ровно один раз', () => {
    const departments = [
      dept('company', 'СУ-10'),
      dept('dept', 'Отдел', 'company'),
      dept('brigade', 'Бригада', 'dept'),
      dept('orphan', 'Сирота', 'missing'),
    ];
    const employees = [
      emp(1, 'Первый', 'dept'),
      emp(2, 'Второй', 'brigade'),
      emp(3, 'Третий', 'orphan'),
      emp(4, 'Четвёртый', null),
      emp(5, 'Пятый', 'unknown-dept'),
    ];

    const roots = buildExportTree({ employees, departments });

    const ids = collectEmployeeIds(roots);
    expect(ids.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(countTreeEmployees(roots)).toBe(5);
  });
});
