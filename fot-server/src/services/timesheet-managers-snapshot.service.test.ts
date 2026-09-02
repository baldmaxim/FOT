import { describe, expect, it } from 'vitest';
import {
  buildVersionManagersSnapshot,
  computeManagersContentHash,
  type IBuildManagersSnapshotInput,
  type IEmployeeDepartmentResolution,
  type IManagerMeta,
} from './timesheet-managers-snapshot.service.js';

const DEPT = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';
const DEPT_OTHER = '60e94f0c-7b39-4c5c-be92-6d8c0ad0d7c4';

const activeManager = (name: string): IManagerMeta => ({
  full_name: name, employment_status: 'active', is_archived: false,
});

const build = (over: Partial<IBuildManagersSnapshotInput> = {}) => buildVersionManagersSnapshot({
  employees: [{ employee_id: 266, full_name: 'Бегас Дмитрий Федорович' }],
  departmentByEmployee: new Map<number, IEmployeeDepartmentResolution>([
    [266, { department_id: DEPT, basis: 'approval_department' }],
  ]),
  managersByDepartment: new Map<string, number[]>(),
  departmentNameById: new Map([[DEPT, 'ЛИНИЯ-Общестрой'], [DEPT_OTHER, 'ЛИНИЯ']]),
  managerMetaById: new Map<number, IManagerMeta>(),
  ...over,
});

const first = (result: ReturnType<typeof build>) => result.payload.employees[0]!;

describe('buildVersionManagersSnapshot', () => {
  it('отдел без назначений → not_configured и пустой массив', () => {
    // Реальный случай ЛИНИЯ-Общестрой: руководитель не назначен вовсе.
    const result = build();
    const employee = first(result);

    expect(employee.resolution_status).toBe('not_configured');
    expect(employee.managers).toEqual([]);
    expect(employee.department_name).toBe('ЛИНИЯ-Общестрой');
    expect(result.withoutManager).toBe(1);
  });

  it('один пригодный руководитель → resolved', () => {
    const result = build({
      managersByDepartment: new Map([[DEPT, [501]]]),
      managerMetaById: new Map([[501, activeManager('Петров Пётр Петрович')]]),
    });
    const employee = first(result);

    expect(employee.resolution_status).toBe('resolved');
    expect(employee.managers).toHaveLength(1);
    expect(employee.managers[0]!.source).toBe('department_full_access');
    expect(employee.managers[0]!.data_quality_issues).toBeUndefined();
    expect(result.withoutManager).toBe(0);
  });

  it('несколько руководителей → multiple, отданы все', () => {
    // Выбирать первого автоматически нельзя — решение за 1С.
    const result = build({
      managersByDepartment: new Map([[DEPT, [502, 501]]]),
      managerMetaById: new Map([
        [501, activeManager('Алексеев А. А.')],
        [502, activeManager('Борисов Б. Б.')],
      ]),
    });
    const employee = first(result);

    expect(employee.resolution_status).toBe('multiple');
    expect(employee.managers.map(m => m.employee_id)).toEqual([501, 502]);
  });

  it('единственный руководитель уволен → invalid_configuration, запись остаётся', () => {
    const result = build({
      managersByDepartment: new Map([[DEPT, [501]]]),
      managerMetaById: new Map([[501, {
        full_name: 'Петров Пётр Петрович', employment_status: 'fired', is_archived: false,
      }]]),
    });
    const employee = first(result);

    expect(employee.resolution_status).toBe('invalid_configuration');
    expect(employee.managers).toHaveLength(1);
    expect(employee.managers[0]!.data_quality_issues).toContain('manager_dismissed');
  });

  it('все назначенные непригодны → invalid_configuration', () => {
    const result = build({
      managersByDepartment: new Map([[DEPT, [501, 502]]]),
      managerMetaById: new Map([
        [501, { full_name: 'Иванов И. И.', employment_status: 'fired', is_archived: false }],
        [502, { full_name: 'Сидоров С. С.', employment_status: 'active', is_archived: true }],
      ]),
    });

    expect(first(result).resolution_status).toBe('invalid_configuration');
  });

  it('руководителя нет в employees → запись не выбрасывается, а помечается', () => {
    // Пропавший employee_id был бы неотличим от «руководителя нет».
    const result = build({
      managersByDepartment: new Map([[DEPT, [999]]]),
      managerMetaById: new Map(),
    });
    const employee = first(result);

    expect(employee.managers).toHaveLength(1);
    expect(employee.managers[0]!.employee_id).toBe(999);
    expect(employee.managers[0]!.full_name).toBeNull();
    expect(employee.managers[0]!.data_quality_issues).toContain('manager_metadata_missing');
    expect(employee.resolution_status).toBe('invalid_configuration');
  });

  it('«тестовое» ФИО помечается, но не удаляется', () => {
    // Проверка по подстроке ненадёжна: настоящая фамилия может содержать «тест».
    const result = build({
      managersByDepartment: new Map([[DEPT, [501]]]),
      managerMetaById: new Map([[501, activeManager('Тестовый Пользователь')]]),
    });
    const employee = first(result);

    expect(employee.managers).toHaveLength(1);
    expect(employee.managers[0]!.data_quality_issues).toContain('manager_name_looks_test');
  });

  it('отдел не определён → department_unknown, а не not_configured', () => {
    const result = build({
      departmentByEmployee: new Map([[266, {
        department_id: null, basis: 'employee_assignment_period',
      }]]),
    });
    const employee = first(result);

    expect(employee.resolution_status).toBe('department_unknown');
    expect(employee.data_quality_issues).toEqual(['department_unknown']);
    expect(employee.department_name).toBeNull();
  });

  it('перевод внутри периода → department_changed_during_period', () => {
    // История достоверна: человек последовательно был в двух отделах.
    const result = build({
      departmentByEmployee: new Map([[266, {
        department_id: DEPT, basis: 'employee_assignment_period', changedDuringPeriod: true,
      }]]),
    });

    expect(first(result).data_quality_issues).toContain('department_changed_during_period');
  });

  it('fallback на карточку сотрудника → department_history_missing', () => {
    const result = build({
      departmentByEmployee: new Map([[266, {
        department_id: DEPT, basis: 'employee_assignment_period', usedSnapshotFallback: true,
      }]]),
    });

    expect(first(result).data_quality_issues).toContain('department_history_missing');
  });

  it('resolution_basis показывает, откуда взят отдел', () => {
    expect(first(build()).resolution_basis).toBe('approval_department');
    expect(first(build({
      departmentByEmployee: new Map([[266, {
        department_id: DEPT, basis: 'employee_assignment_period',
      }]]),
    })).resolution_basis).toBe('employee_assignment_period');
  });

  it('сотрудники отсортированы по employee_id', () => {
    const result = build({
      employees: [
        { employee_id: 300, full_name: 'Б' },
        { employee_id: 100, full_name: 'А' },
      ],
      departmentByEmployee: new Map([
        [300, { department_id: DEPT, basis: 'approval_department' }],
        [100, { department_id: DEPT, basis: 'approval_department' }],
      ]),
    });

    expect(result.payload.employees.map(e => e.employee_id)).toEqual([100, 300]);
  });
});

describe('computeManagersContentHash', () => {
  const hashOf = (over: Partial<IBuildManagersSnapshotInput> = {}) =>
    computeManagersContentHash(build(over).payload);

  const withManager = (ids: number[]) => ({
    managersByDepartment: new Map([[DEPT, ids]]),
    managerMetaById: new Map(ids.map(id => [id, activeManager(`Руководитель ${id}`)])),
  });

  it('одинаковый вход — одинаковый хэш', () => {
    expect(hashOf(withManager([501]))).toBe(hashOf(withManager([501])));
  });

  it('порядок руководителей на входе на хэш не влияет', () => {
    expect(hashOf(withManager([502, 501]))).toBe(hashOf(withManager([501, 502])));
  });

  it('смена руководителя меняет хэш', () => {
    // Иначе правка кадров не попадёт в 1С: content_hash табеля при этом не меняется.
    expect(hashOf(withManager([501]))).not.toBe(hashOf(withManager([777])));
  });

  it('появление руководителя там, где его не было, меняет хэш', () => {
    expect(hashOf()).not.toBe(hashOf(withManager([501])));
  });
});
