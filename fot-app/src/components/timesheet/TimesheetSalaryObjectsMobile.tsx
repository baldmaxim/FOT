import type { FC, ReactNode } from 'react';

import type { ITimesheetSalaryObject, ITimesheetSalaryResponse, ITimesheetSalaryRow } from '../../types/timesheet';
import { formatHoursLabel } from '../../utils/hoursDisplay';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import {
  formatSalaryAmount,
  objectShareTitle,
  salaryAmountTitle,
  salaryObjectStateNote,
  totalDaysOfEmployee,
} from '../../utils/timesheetSalary';
import { TimesheetSalaryKtuSelect, type ITimesheetSalaryGridProps } from './TimesheetSalaryCells';

interface ITimesheetSalaryObjectsMobileProps {
  data: ITimesheetSalaryResponse;
  /** Строки бригады по ФИО. */
  rows: ITimesheetSalaryRow[];
  salary: ITimesheetSalaryGridProps;
  muted: boolean;
  nameOf: (employeeId: number) => string;
  order: ReadonlyMap<number, number>;
  outputField: (object: ITimesheetSalaryObject) => ReactNode;
}

const amountClass = (muted: boolean, amount: string | null | undefined): string => (
  `ts-salary-object-card-amount${muted && amount ? ' ts-salary-amount--stale' : ''}`
);

/**
 * «Зарплата по объектам» на телефоне: карточка на объект — «Выработка, ₽» и рабочие строкой «ФИО · КТУ · ч · доля»;
 * внизу «Итого по бригаде» с «Суммой». Часы по дням — во вкладке «По объектам».
 */
export const TimesheetSalaryObjectsMobile: FC<ITimesheetSalaryObjectsMobileProps> = ({
  data, rows, salary, muted, nameOf, order, outputField,
}) => {
  const rowById = new Map(rows.map(row => [row.employee_id, row]));
  const objects = data.objects ?? [];
  return (
    <div className="ts-salary-objects-mobile">
      {objects.length === 0 && <div className="ts-loading">Нет часов бригады на объектах за месяц</div>}
      {objects.map(object => {
        const note = salaryObjectStateNote(object);
        const members = [...object.members].sort((a, b) => (
          (order.get(a.employee_id) ?? 0) - (order.get(b.employee_id) ?? 0)
        ));
        return (
          <section key={object.object_key} className="ts-salary-object-card" aria-label={object.object_name}>
            <header className="ts-salary-object-card-head">
              <span className="ts-object-group-name">{object.object_name}</span>
              <span className="ts-object-group-meta">
                {object.members.length} чел.{object.total_hours > 0 ? ` (${Math.round(object.total_hours)} ч.)` : ''}
              </span>
            </header>
            <label className="ts-salary-output ts-salary-object-card-output">
              <span className="ts-salary-output-label">Выработка, ₽</span>
              {outputField(object)}
            </label>
            {note && <span className="ts-salary-object-note">{note}</span>}
            <ul className="ts-salary-object-card-list">
              {members.map(member => {
                const row = rowById.get(member.employee_id);
                return (
                  <li key={member.employee_id} className="ts-salary-object-card-row">
                    <span className="ts-salary-object-card-name">{formatTimesheetEmployeeName(nameOf(member.employee_id))}</span>
                    {row && (
                      <label className="ts-salary-mobile-field">
                        <span>КТУ</span>
                        <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(member.employee_id)} />
                      </label>
                    )}
                    <span className="ts-salary-object-card-hours">{member.hours > 0 ? formatHoursLabel(member.hours) : '—'}</span>
                    <span className={amountClass(muted, member.share)} title={objectShareTitle(object, member)}>
                      {formatSalaryAmount(member.share)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {rows.length > 0 && (
        <section className="ts-salary-object-card ts-salary-object-card--total" aria-label="Итого по бригаде">
          <header className="ts-salary-object-card-head">
            <span className="ts-object-group-name">Итого по бригаде</span>
            <span className="ts-object-group-meta">{rows.length} чел.</span>
          </header>
          <ul className="ts-salary-object-card-list">
            {rows.map(row => {
              const hours = Object.values(totalDaysOfEmployee(data, row.employee_id)).reduce((sum, value) => sum + value, 0);
              return (
                <li key={row.employee_id} className="ts-salary-object-card-row">
                  <span className="ts-salary-object-card-name">{formatTimesheetEmployeeName(nameOf(row.employee_id))}</span>
                  <label className="ts-salary-mobile-field">
                    <span>КТУ</span>
                    <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(row.employee_id)} />
                  </label>
                  <span className="ts-salary-object-card-hours">{hours > 0 ? formatHoursLabel(hours) : '—'}</span>
                  <span className="ts-salary-object-card-share">Доля {formatSalaryAmount(row.share ?? null)}</span>
                  <span className={amountClass(muted, row.amount)} title={salaryAmountTitle(data, row)}>
                    {formatSalaryAmount(row.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
};
