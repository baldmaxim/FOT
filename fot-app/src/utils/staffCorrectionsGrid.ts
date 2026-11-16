import type { IStaffWeekendRow } from '../services/staffWeekendService';
import {
  authorText,
  formatChangedAt,
  formatCorrectionHours,
  skudText,
  type IStaffCorrectionTableRow,
} from './staffCorrectionsTable';

/**
 * Вкладка «Корректировки» в виде табеля: сетка отдела только по людям с правками руководителей, такие дни — в рамке.
 * Подсказка дня — кто и когда поставил, по СКУД → часы правки, комментарий; у ФИО — «N корр.».
 */

export const CORRECTIONS_LEGEND_LABEL = 'Корректировка руководителя';

export interface ICorrectionGridBadge {
  text: string;
  title: string;
}

export interface ICorrectionGridMarks {
  /** Люди сетки по ФИО — для pickWeekendGridData. */
  people: IStaffWeekendRow[];
  /** Ключи клеток `${employee_id}_${YYYY-MM-DD}`. */
  keys: Set<string>;
  titles: Map<string, string>;
  badges: Map<number, ICorrectionGridBadge[]>;
}

const correctionTitle = (row: IStaffCorrectionTableRow): string => {
  const object = row.object_name ? ` (${row.object_name})` : '';
  const reason = row.reason ? ` · ${row.reason}` : '';
  return `${authorText(row)}, ${formatChangedAt(row.changed_at)}: по СКУД ${skudText(row)} → `
    + `${formatCorrectionHours(row.hours)} ч${object}${reason}`;
};

export const buildCorrectionGridMarks = (rows: ReadonlyArray<IStaffCorrectionTableRow>): ICorrectionGridMarks => {
  const byKey = new Map<string, IStaffCorrectionTableRow[]>();
  const byEmployee = new Map<number, { full_name: string; days: Set<string>; count: number }>();
  for (const row of rows) {
    const key = `${row.employee_id}_${row.work_date}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
    const person = byEmployee.get(row.employee_id) ?? { full_name: row.full_name, days: new Set<string>(), count: 0 };
    person.days.add(row.work_date);
    person.count += 1;
    byEmployee.set(row.employee_id, person);
  }

  const people = [...byEmployee]
    .map(([employeeId, person]): IStaffWeekendRow => ({
      employee_id: employeeId,
      full_name: person.full_name,
      position: null,
      days: [...person.days].sort(),
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));

  return {
    people,
    keys: new Set(byKey.keys()),
    titles: new Map([...byKey].map(([key, dayRows]) => [key, dayRows.map(correctionTitle).join('; ')])),
    badges: new Map([...byEmployee].map(([employeeId, person]) => [
      employeeId,
      [{ text: `${person.count} корр.`, title: CORRECTIONS_LEGEND_LABEL }],
    ])),
  };
};
