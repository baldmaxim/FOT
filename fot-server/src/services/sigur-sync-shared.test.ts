import { describe, expect, it } from 'vitest';

import {
  normalizeDepartmentLookupName,
  reconcileSyncFilterDepartments,
  type INormalizedDept,
  type ISyncFilterDepartmentRow,
} from './sigur-sync-shared.js';

describe('sigur-sync-shared', () => {
  it('normalizes department names for stable matching', () => {
    expect(normalizeDepartmentLookupName('  Служба\tМеханизации  ')).toBe('служба механизации');
    expect(normalizeDepartmentLookupName('Ёлкино')).toBe('елкино');
  });

  it('remaps stale sync-filter ids by current department name and deduplicates duplicates', () => {
    const departments: INormalizedDept[] = [
      { id: 142052, name: '(СМ) Служба механизации', parentId: null },
      { id: 140795, name: '(ИД) Отдел исполнительной документации', parentId: null },
    ];
    const rows: ISyncFilterDepartmentRow[] = [
      { sigur_department_id: 140952, sigur_department_name: '(СМ) Служба механизации' },
      { sigur_department_id: 142052, sigur_department_name: '(СМ) Служба Механизации' },
      { sigur_department_id: 999999, sigur_department_name: 'Неизвестный отдел' },
    ];

    const reconciled = reconcileSyncFilterDepartments(rows, departments);

    expect([...(reconciled.effectiveIds || new Set<number>())]).toEqual([142052]);
    expect(reconciled.persistedRows).toEqual([
      {
        sigur_department_id: 142052,
        sigur_department_name: '(СМ) Служба механизации',
      },
      {
        sigur_department_id: 999999,
        sigur_department_name: 'Неизвестный отдел',
      },
    ]);
    expect(reconciled.unresolvedRows).toEqual([
      {
        sigur_department_id: 999999,
        sigur_department_name: 'Неизвестный отдел',
      },
    ]);
    expect(reconciled.changed).toBe(true);
  });

  it('falls back to the original ids when nothing can be remapped yet', () => {
    const departments: INormalizedDept[] = [
      { id: 1, name: 'Новый отдел', parentId: null },
    ];
    const rows: ISyncFilterDepartmentRow[] = [
      { sigur_department_id: 77, sigur_department_name: 'Старый отдел' },
    ];

    const reconciled = reconcileSyncFilterDepartments(rows, departments);

    expect([...(reconciled.effectiveIds || new Set<number>())]).toEqual([77]);
    expect(reconciled.unresolvedRows).toHaveLength(1);
    expect(reconciled.changed).toBe(false);
  });
});
