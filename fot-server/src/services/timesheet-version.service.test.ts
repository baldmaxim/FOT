import { describe, expect, it } from 'vitest';
import {
  computeContentHash,
  resolveState,
  type ITimesheetVersionPayload,
} from './timesheet-version.service.js';

/**
 * content_hash — то, по чему 1С отличает «данные те же» от «табель переделали».
 * Он обязан быть устойчив к порядку ключей и чувствителен к любому семантическому полю.
 */

const basePayload = (): ITimesheetVersionPayload => ({
  approval: {
    id: 855,
    scope: {
      kind: 'department',
      department_id: '0e2c9f3a-1b4d-4c8e-9a10-2f3b4c5d6e7f',
      department_name: 'бр. Иванова',
      manager_employee_id: null,
    },
    start_date: '2026-08-01',
    end_date: '2026-08-15',
    status: 'approved',
  },
  employees_count: 2,
  total_hours: 128,
  employees: [
    {
      identity: { employee_id: 501, sigur_employee_id: 60807, tab_number: '01476', full_name: 'Иванов И. И.' },
      position: 'Маляр',
      total_hours: 128,
      zero_activity: false,
      days: {
        '2026-08-01': { status: 'work', hours: 8, corrected: false, hours_overridden: false },
        '2026-08-02': { status: 'vacation', hours: 0, corrected: true, hours_overridden: false },
      },
      object_rows: [],
    },
    {
      identity: { employee_id: 502, sigur_employee_id: null, tab_number: null, full_name: 'Петров П. П.' },
      position: null,
      total_hours: 0,
      zero_activity: true,
      days: {},
      object_rows: [],
    },
  ],
});

describe('computeContentHash', () => {
  it('не зависит от порядка ключей в объектах', () => {
    const a = basePayload();

    // Тот же payload, собранный в другом порядке вставки ключей.
    const b: ITimesheetVersionPayload = {
      employees: a.employees.map(employee => ({
        object_rows: employee.object_rows,
        days: Object.fromEntries(Object.entries(employee.days).reverse()) as typeof employee.days,
        zero_activity: employee.zero_activity,
        total_hours: employee.total_hours,
        position: employee.position,
        identity: {
          full_name: employee.identity.full_name,
          tab_number: employee.identity.tab_number,
          sigur_employee_id: employee.identity.sigur_employee_id,
          employee_id: employee.identity.employee_id,
        },
      })),
      total_hours: a.total_hours,
      employees_count: a.employees_count,
      approval: a.approval,
    };

    expect(computeContentHash(b)).toBe(computeContentHash(a));
  });

  it('стабилен между вызовами на одних данных', () => {
    expect(computeContentHash(basePayload())).toBe(computeContentHash(basePayload()));
  });

  it('меняется при правке часов', () => {
    const changed = basePayload();
    changed.employees[0]!.days['2026-08-01']!.hours = 4;
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при смене статуса дня', () => {
    const changed = basePayload();
    changed.employees[0]!.days['2026-08-02']!.status = 'sick';
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при смене табельного номера — 1С получает другой identity', () => {
    const changed = basePayload();
    changed.employees[0]!.identity.tab_number = '99999';
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при изменении состава', () => {
    const changed = basePayload();
    changed.employees = [changed.employees[0]!];
    changed.employees_count = 1;
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при переключении одного zero_activity', () => {
    // Флаг решает, попадёт ли строка в документ 1С, — значит он семантический.
    const changed = basePayload();
    changed.employees[1]!.zero_activity = false;
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при заполнении object_rows — поле зарезервировано, но входит в хэш', () => {
    const changed = basePayload();
    changed.employees[0]!.object_rows = [{ object_id: 'obj-1', hours: 8 }];
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('меняется при смене периода подачи', () => {
    const changed = basePayload();
    changed.approval.end_date = '2026-08-31';
    expect(computeContentHash(changed)).not.toBe(computeContentHash(basePayload()));
  });

  it('не зависит от порядка сотрудников в массиве', () => {
    // Сборщик сортирует по employee_id, но хэш не должен ломаться, если порядок иной.
    const reordered = basePayload();
    reordered.employees = [...reordered.employees].reverse();
    const canonical = basePayload();
    canonical.employees = [...canonical.employees].reverse();
    expect(computeContentHash(reordered)).toBe(computeContentHash(canonical));
  });
});

describe('resolveState', () => {
  it('версии нет — not_exported', () => {
    expect(resolveState(null, null)).toBe('not_exported');
  });

  it('версия есть, подтверждения нет — not_exported', () => {
    expect(resolveState(10, null)).toBe('not_exported');
  });

  it('подтверждена текущая версия — exported', () => {
    expect(resolveState(10, 10)).toBe('exported');
  });

  it('подтверждена более ранняя версия — stale', () => {
    expect(resolveState(11, 10)).toBe('stale');
  });
});
