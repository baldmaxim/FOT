import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

vi.mock('../config/postgres.js', () => ({ query: vi.fn() }));
vi.mock('../config/db-instrumentation.js', () => ({
  withDbSlot: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('./department-access.service.js', () => ({
  listEditableDepartmentIdsForUser: vi.fn(),
  listExplicitDepartmentIdsForUser: vi.fn(),
  loadEmployeeAccessMap: vi.fn(),
}));
vi.mock('./employee-skud-object-access.service.js', () => ({
  listObjectIdsForEmployee: vi.fn(),
}));
vi.mock('./employee-direct-reports.service.js', () => ({
  listDirectSubordinates: vi.fn(async () => []),
}));
vi.mock('./timekeeper-scope.service.js', () => ({
  isTimekeeper: () => false,
  resolveTimekeeperDepartmentSeeds: vi.fn(async () => []),
  resolveTimekeeperDirectEmployeeIds: vi.fn(async () => new Set<number>()),
}));

import { query } from '../config/postgres.js';
import {
  listEditableDepartmentIdsForUser,
  listExplicitDepartmentIdsForUser,
  loadEmployeeAccessMap,
} from './department-access.service.js';
import { listObjectIdsForEmployee } from './employee-skud-object-access.service.js';
import {
  resolveAccessibleEmployeeIds,
  resolveEditableEmployeeIds,
  canEditEmployeeInScope,
  canAccessEmployeeInScope,
  hasObjectViewScope,
} from './data-scope.service.js';

// Сценарий: руководитель (employee_id=100).
//  - full-отдел 'full' (свой) → член 300 (редактируемый);
//  - view-отдел 'view' (Линия) → члены 200 (на объекте) и 201 (НЕ на объекте);
//  - объекты руководителя: ['obj1'] → сотрудники объекта {200, 100}.
// Ожидаем: видны 300 (full) и 200 (view∩объект); 201 (view, не на объекте) — нет.
const makeReq = (): AuthenticatedRequest => ({
  user: { id: 'u1', is_admin: false, role_code: 'manager_obj', employee_id: 100 },
} as unknown as AuthenticatedRequest);

const DEPT_MEMBERS: Record<string, number[]> = { full: [300], view: [200, 201] };
const EMP_DEPTS: Record<number, string[]> = { 200: ['view'], 201: ['view'], 300: ['full'] };

beforeEach(() => {
  vi.clearAllMocks();
  (query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params?: unknown[]) => {
    const p0 = (params?.[0] as string[]) ?? [];
    if (sql.includes('get_descendant_department_ids')) {
      return [...new Set(p0)].map(id => ({ id })); // без потомков
    }
    if (sql.includes('employee_skud_object_access')) {
      return [{ employee_id: 200 }, { employee_id: 100 }]; // сотрудники объекта руководителя
    }
    if (sql.includes('employee_department_access')) {
      const depts = new Set(p0);
      const out: Array<{ employee_id: number }> = [];
      for (const [dept, members] of Object.entries(DEPT_MEMBERS)) {
        if (depts.has(dept)) for (const m of members) out.push({ employee_id: m });
      }
      return out;
    }
    return [];
  });
  (listEditableDepartmentIdsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(['full']);
  (listExplicitDepartmentIdsForUser as ReturnType<typeof vi.fn>).mockResolvedValue(['full', 'view']);
  (listObjectIdsForEmployee as ReturnType<typeof vi.fn>).mockResolvedValue(['obj1']);
  (loadEmployeeAccessMap as ReturnType<typeof vi.fn>).mockImplementation(async (empIds: number[]) => {
    const m = new Map<number, string[]>();
    for (const id of empIds) m.set(id, EMP_DEPTS[id] ?? []);
    return m;
  });
});

describe('объектный view-скоуп (отделы ∩ объекты, миграция 167)', () => {
  it('resolveAccessibleEmployeeIds = full-члены + (view ∩ объекты) + self', async () => {
    const acc = await resolveAccessibleEmployeeIds(makeReq());
    expect(acc).not.toBe('all');
    const set = acc as Set<number>;
    expect(set.has(300)).toBe(true);   // full-отдел
    expect(set.has(200)).toBe(true);   // view ∩ объект
    expect(set.has(100)).toBe(true);   // сам руководитель
    expect(set.has(201)).toBe(false);  // view, но НЕ на объекте
  });

  it('resolveEditableEmployeeIds = только full-члены + self (без view)', async () => {
    const ed = await resolveEditableEmployeeIds(makeReq());
    const set = ed as Set<number>;
    expect(set.has(300)).toBe(true);
    expect(set.has(100)).toBe(true);
    expect(set.has(200)).toBe(false); // view не редактируем
    expect(set.has(201)).toBe(false);
  });

  it('canAccessEmployeeInScope: view∩объект — да, view вне объекта — нет, full — да', async () => {
    expect(await canAccessEmployeeInScope(makeReq(), 200)).toBe(true);
    expect(await canAccessEmployeeInScope(makeReq(), 201)).toBe(false);
    expect(await canAccessEmployeeInScope(makeReq(), 300)).toBe(true);
  });

  it('canEditEmployeeInScope: view∩объект — нет (read-only), full — да', async () => {
    expect(await canEditEmployeeInScope(makeReq(), 200)).toBe(false);
    expect(await canEditEmployeeInScope(makeReq(), 300)).toBe(true);
  });

  it('hasObjectViewScope = true при объектах + view-отделах', async () => {
    expect(await hasObjectViewScope(makeReq())).toBe(true);
  });

  it('фолбэк: без объектов view-отдел виден целиком', async () => {
    (listObjectIdsForEmployee as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await hasObjectViewScope(makeReq())).toBe(false);
    const acc = await resolveAccessibleEmployeeIds(makeReq());
    const set = acc as Set<number>;
    expect(set.has(200)).toBe(true);
    expect(set.has(201)).toBe(true); // без объектов фильтр не применяется
    // canAccess для view-члена тоже true (фолбэк)
    expect(await canAccessEmployeeInScope(makeReq(), 201)).toBe(true);
  });
});
