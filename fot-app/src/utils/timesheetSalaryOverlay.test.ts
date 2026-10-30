import { describe, expect, it } from 'vitest';

import type { ITimesheetSalaryObject, ITimesheetSalaryObjectMember, ITimesheetSalaryResponse } from '../types/timesheet';
import {
  buildSalaryObjectsOverlay,
  salaryCalcCellText,
  salaryTotalRows,
  SALARY_UNKNOWN_OBJECT_KEY,
  type ISalaryObjectsOverlay,
  type ISalaryOverlayGroup,
} from './timesheetSalaryOverlay';

const K13 = '11111111-1111-1111-1111-111111111111';
const K14 = '22222222-2222-2222-2222-222222222222';
const PINNED = '33333333-3333-3333-3333-333333333333';
const CURRENT = '__current_activity__';
const SYNTHETIC = '__timesheet_unassigned__';

const member = (employeeId: number, share: string | null, days: Record<string, number> = { '2026-10-01': 11 }): ITimesheetSalaryObjectMember => ({
  employee_id: employeeId, days, hours: 11, counted_minutes: 660, weight: 6600, share,
});

const object = (key: string, members: ITimesheetSalaryObjectMember[], output: string | null = '100000.00'): ITimesheetSalaryObject => ({
  object_key: key, object_name: key, output_amount: output, state: output === null ? 'no_output' : 'ok',
  total_hours: 11, total_weight: 6600, members,
});

const group = (key: string, employeeIds: number[], isSynthetic = false): ISalaryOverlayGroup => ({
  object_key: key, isSynthetic, employeeIds,
});

/** Где показана каждая пара (объект, сотрудник) расчёта — должно быть ровно одно место. */
const shownPairs = (overlay: ISalaryObjectsOverlay, groups: readonly ISalaryOverlayGroup[]): string[] => {
  const pairs: string[] = [];
  for (const item of groups) {
    const mapped = overlay.objectByGroup.get(item.object_key);
    if (!mapped) continue;
    for (const employeeId of item.employeeIds) {
      if (mapped.members.some(entry => entry.employee_id === employeeId)) pairs.push(`${mapped.object_key}:${employeeId}`);
    }
    for (const extra of overlay.extraMembersByGroup.get(item.object_key) ?? []) {
      pairs.push(`${mapped.object_key}:${extra.employee_id}`);
    }
  }
  for (const unmatched of overlay.unmatched) {
    for (const entry of unmatched.members) pairs.push(`${unmatched.object_key}:${entry.employee_id}`);
  }
  return pairs.sort();
};

const allPairs = (objects: readonly ITimesheetSalaryObject[]): string[] => (
  objects.flatMap(item => item.members.map(entry => `${item.object_key}:${entry.employee_id}`)).sort()
);

describe('buildSalaryObjectsOverlay — расчёт поверх сетки «По объектам»', () => {
  it('совпавшая пара: объект — к группе с тем же ключом, лишнего нет', () => {
    const objects = [object(K14, [member(1, '50000.00'), member(2, '50000.00')])];
    const groups = [group(K14, [1, 2, 99])];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.objectByGroup.get(K14)?.object_key).toBe(K14);
    expect(overlay.extraMembersByGroup.size).toBe(0);
    expect(overlay.unmatched).toEqual([]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('сотрудник расчёта вне строк группы — строкой «только в расчёте» под ней', () => {
    const objects = [object(K13, [member(1, '30000.00'), member(5, '70000.00')])];
    const groups = [group(K13, [1])];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.extraMembersByGroup.get(K13)?.map(entry => entry.employee_id)).toEqual([5]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('«Не определён» без своей группы — к синтетической «Не определён / без объекта»', () => {
    const objects = [object(SALARY_UNKNOWN_OBJECT_KEY, [member(7, '10000.00'), member(8, '20000.00')], null)];
    const groups = [group(K14, [1]), group(SYNTHETIC, [7, 8], true)];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.objectByGroup.get(SYNTHETIC)?.object_key).toBe(SALARY_UNKNOWN_OBJECT_KEY);
    expect(overlay.objectByGroup.has(K14)).toBe(false);
    expect(overlay.unmatched).toEqual([]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('«Не определён» со своей группой — к ней; синтетическая без финансов, её люди — строками «только в расчёте»', () => {
    const objects = [object(SALARY_UNKNOWN_OBJECT_KEY, [member(3, '10000.00'), member(7, '5000.00')])];
    const groups = [group(SALARY_UNKNOWN_OBJECT_KEY, [3]), group(SYNTHETIC, [7], true)];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.objectByGroup.get(SALARY_UNKNOWN_OBJECT_KEY)?.object_key).toBe(SALARY_UNKNOWN_OBJECT_KEY);
    expect(overlay.objectByGroup.has(SYNTHETIC)).toBe(false);
    expect(overlay.extraMembersByGroup.get(SALARY_UNKNOWN_OBJECT_KEY)?.map(entry => entry.employee_id)).toEqual([7]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('«Текущая деятельность» и закреплённый объект без группы — свои группы ниже, синтетическая их не забирает', () => {
    const objects = [
      object(K14, [member(1, '100000.00')]),
      object(CURRENT, [member(7, '20000.00')]),
      object(PINNED, [member(8, null)], null),
    ];
    const groups = [group(K14, [1]), group(SYNTHETIC, [7, 8], true)];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.unmatched.map(item => item.object_key)).toEqual([CURRENT, PINNED]);
    expect(overlay.objectByGroup.has(SYNTHETIC)).toBe(false);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('объект только в табеле (появился сегодня) — без объекта расчёта; только в расчёте — своей группой', () => {
    const objects = [object(K13, [member(2, '40000.00')]), object(K14, [], '5000.00')];
    const groups = [group(K13, [2]), group(PINNED, [2])];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.objectByGroup.has(PINNED)).toBe(false);
    expect(overlay.unmatched.map(item => item.object_key)).toEqual([K14]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });

  it('сотрудник расчёта без строки табеля нигде в сетке — не теряется', () => {
    const objects = [object(K14, [member(1, '60000.00'), member(404, '40000.00')])];
    const groups = [group(K14, [1])];
    const overlay = buildSalaryObjectsOverlay(groups, objects);
    expect(overlay.extraMembersByGroup.get(K14)?.map(entry => entry.employee_id)).toEqual([404]);
    expect(shownPairs(overlay, groups)).toEqual(allPairs(objects));
  });
});

describe('клетка строки «только в расчёте»', () => {
  it('часы расчёта важнее буквы табеля: снимок 10 ч, в табеле теперь «Н» — «10»', () => {
    expect(salaryCalcCellText(10, 'Н')).toBe('10');
    expect(salaryCalcCellText(8.5, '')).toBe('9');
    expect(salaryCalcCellText(0.42, '—')).toBe('0');
  });

  it('дня в расчёте нет — что в табеле', () => {
    expect(salaryCalcCellText(undefined, 'Н')).toBe('Н');
    expect(salaryCalcCellText(undefined, '—')).toBe('—');
    expect(salaryCalcCellText(undefined, '')).toBe('');
  });
});

describe('«Итого по бригаде» и «Все сотрудники»', () => {
  const data: ITimesheetSalaryResponse = {
    department_id: 'b', month: '2026-10', kind: 'brigade', state: 'preliminary', distribution: 'ok',
    as_of: '2026-10-29', open_ranges: [], output_amount: '100000.00', errors: [], computed_at: null,
    rows: [
      { employee_id: 1, full_name: 'Амонов А. М.', ktu: '1.0', counted_hours: 11, amount: '100000.00', share: '100000.00', source: 'live', can_edit: true },
      { employee_id: 2, full_name: 'Боев Б. Д.', ktu: '1.0', counted_hours: 0, amount: null, share: null, source: 'live', can_edit: true },
      { employee_id: 3, full_name: 'Юсупов С. Н.', ktu: '1.0', counted_hours: 0, amount: null, share: null, source: 'live', can_edit: true },
    ],
    objects: [object(K14, [member(1, '100000.00'), member(2, null, {})])],
  };

  it('выключено — только те, у кого есть часы на объектах', () => {
    expect(salaryTotalRows(data.rows, data, false).map(row => row.employee_id)).toEqual([1]);
  });

  it('включено — весь состав расчёта, каждый один раз', () => {
    expect(salaryTotalRows(data.rows, data, true).map(row => row.employee_id)).toEqual([1, 2, 3]);
  });
});
