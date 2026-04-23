import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/database.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: {},
}));

vi.mock('./sigur-linked-employees.service.js', () => ({
  getEmployeeAccessPointBindings: vi.fn(),
  invalidateEmployeeAccessPointBindingsCache: vi.fn(),
  replaceEmployeeAccessPointBindings: vi.fn(),
}));

import {
  buildSigurDepartmentTree,
  collectSigurDepartmentDescendantIds,
  listSigurEmployees,
  normalizeSigurEmployeeSummary,
} from './sigur-live-admin.service.js';
import { sigurService } from './sigur.service.js';

const mockedSigurService = sigurService as unknown as Record<string, ReturnType<typeof vi.fn>>;

const testDepartments = [
  { id: 1, parentId: null, name: 'Root' },
  { id: 2, parentId: 1, name: 'Assembly' },
  { id: 3, parentId: 1, name: 'Warehouse' },
];

const buildEmployees = (count: number, departmentId = 2, blocked = false): Record<string, unknown>[] => (
  Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return {
      id,
      name: `Employee ${String(id).padStart(3, '0')}`,
      departmentId,
      positionId: null,
      positionName: null,
      tabId: null,
      blocked,
    };
  })
);

beforeEach(() => {
  mockedSigurService.getDepartmentsCached = vi.fn(async () => testDepartments);
  mockedSigurService.getEmployeeCountByDepartmentCached = vi.fn(async () => new Map([[2, 120], [3, 80]]));
  mockedSigurService.getEmployeesPage = vi.fn(async () => buildEmployees(100));
  mockedSigurService.getEmployeesCount = vi.fn(async () => 100);
});

describe('sigur-live-admin helpers', () => {
  it('collects selected department with all descendants', () => {
    const ids = collectSigurDepartmentDescendantIds(10, [
      { id: 10, parentId: null },
      { id: 11, parentId: 10 },
      { id: 12, parentId: 11 },
      { id: 13, parentId: 10 },
      { id: 99, parentId: null },
    ]);

    expect([...ids]).toEqual([10, 13, 11, 12]);
  });

  it('normalizes employee summary and falls back to department map', () => {
    const employee = normalizeSigurEmployeeSummary(
      {
        id: 77,
        name: 'Иван Петров',
        departmentId: 11,
        positionId: 3,
        positionName: 'Инженер',
        tabNumber: 'A-15',
        blocked: 1,
      },
      new Map([[11, 'Монтажный отдел']]),
    );

    expect(employee).toEqual({
      id: 77,
      name: 'Иван Петров',
      departmentId: 11,
      departmentName: 'Монтажный отдел',
      positionId: 3,
      positionName: 'Инженер',
      tabId: 'A-15',
      blocked: true,
    });
  });

  it('builds sorted department tree and aggregates employee counts from children', () => {
    const tree = buildSigurDepartmentTree(
      [
        { id: 1, parentId: null, name: 'База' },
        { id: 2, parentId: 1, name: 'Склад' },
        { id: 3, parentId: 1, name: 'Администрация' },
        { id: 4, parentId: 3, name: 'Бухгалтерия' },
      ],
      [
        {
          id: 101,
          name: 'А',
          departmentId: 3,
          departmentName: 'Администрация',
          positionId: null,
          positionName: null,
          tabId: null,
          blocked: false,
        },
        {
          id: 102,
          name: 'Б',
          departmentId: 4,
          departmentName: 'Бухгалтерия',
          positionId: null,
          positionName: null,
          tabId: null,
          blocked: false,
        },
        {
          id: 103,
          name: 'В',
          departmentId: 2,
          departmentName: 'Склад',
          positionId: null,
          positionName: null,
          tabId: null,
          blocked: false,
        },
      ],
    );

    expect(tree).toEqual([
      {
        id: 1,
        parentId: null,
        name: 'База',
        hasChildren: true,
        employeeCount: 3,
        employeeCountLoaded: true,
        children: [
          {
            id: 3,
            parentId: 1,
            name: 'Администрация',
            hasChildren: true,
            employeeCount: 2,
            employeeCountLoaded: true,
            children: [
              {
                id: 4,
                parentId: 3,
                name: 'Бухгалтерия',
                hasChildren: false,
                employeeCount: 1,
                employeeCountLoaded: true,
                children: [],
              },
            ],
          },
          {
            id: 2,
            parentId: 1,
            name: 'Склад',
            hasChildren: false,
            employeeCount: 1,
            employeeCountLoaded: true,
            children: [],
          },
        ],
      },
    ]);
  });

  it('uses object count for all employees pagination', async () => {
    mockedSigurService.getEmployeesCount.mockResolvedValueOnce({ count: 237 });

    const result = await listSigurEmployees(
      { departmentId: null, search: null, blocked: null },
      { page: 1, pageSize: 100 },
    );

    expect(result.items).toHaveLength(100);
    expect(result.total).toBe(237);
    expect(mockedSigurService.getEmployeesPage).toHaveBeenCalledWith({}, { limit: 100, offset: 0 }, undefined);
    expect(mockedSigurService.getEmployeeCountByDepartmentCached).not.toHaveBeenCalled();
  });

  it('falls back to department count sum when all employees count is not parseable', async () => {
    mockedSigurService.getEmployeesCount.mockResolvedValueOnce({ unexpected: true });

    const result = await listSigurEmployees(
      { departmentId: null, search: null, blocked: null },
      { page: 1, pageSize: 100 },
    );

    expect(result.items).toHaveLength(100);
    expect(result.total).toBe(200);
    expect(mockedSigurService.getEmployeeCountByDepartmentCached).toHaveBeenCalledTimes(1);
  });

  it('uses count endpoint for filtered department employees', async () => {
    mockedSigurService.getEmployeesPage.mockResolvedValueOnce(buildEmployees(100, 2, false));
    mockedSigurService.getEmployeesCount.mockResolvedValueOnce({ data: { totalCount: 142 } });

    const result = await listSigurEmployees(
      { departmentId: 2, search: null, blocked: false },
      { page: 1, pageSize: 100 },
    );

    expect(result.items).toHaveLength(100);
    expect(result.total).toBe(142);
    expect(mockedSigurService.getEmployeesPage).toHaveBeenCalledWith(
      { departmentId: 2, blocked: false },
      { limit: 100, offset: 0 },
      undefined,
    );
    expect(mockedSigurService.getEmployeesCount).toHaveBeenCalledWith(
      { departmentId: 2, blocked: false },
      undefined,
    );
    expect(mockedSigurService.getEmployeeCountByDepartmentCached).not.toHaveBeenCalled();
  });
});
