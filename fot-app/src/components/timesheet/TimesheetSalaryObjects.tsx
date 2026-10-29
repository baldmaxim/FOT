import { Fragment, useMemo, type FC } from 'react';

import type { ITimesheetSalaryObject, ITimesheetSalaryResponse } from '../../types/timesheet';
import { getDaysInMonth, getWeekdayShort, isToday, isWeekend } from '../../utils/calendarUtils';
import { formatHoursLabel } from '../../utils/hoursDisplay';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import {
  describeSalaryState,
  formatDayHours,
  formatSalaryAmount,
  isOutputClearOnly,
  isSalaryRowMuted,
  objectShareTitle,
  salaryAmountTitle,
  salaryObjectStateNote,
  sortSalaryRows,
  totalDaysOfEmployee,
} from '../../utils/timesheetSalary';
import { TimesheetSalaryKtuSelect, type ITimesheetSalaryGridProps } from './TimesheetSalaryCells';
import { TimesheetSalaryObjectsMobile } from './TimesheetSalaryObjectsMobile';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';

export interface ITimesheetSalaryObjectsProps {
  data: ITimesheetSalaryResponse | undefined;
  loading: boolean;
  year: number;
  month: number;
  compact: boolean;
  canEdit: boolean;
  pendingKtuEmployeeId: number | null;
  savingObjectKey: string | null;
  onKtuChange: (employeeId: number, ktu: number) => void;
  onObjectOutputSave: (objectKey: string, amount: number | null) => Promise<void>;
}

const isoDay = (year: number, month: number, day: number): string => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

interface IDayCellsProps {
  year: number;
  month: number;
  days: number[];
  hoursByDate: Record<string, number>;
}

/** Часы по дням — только для чтения: правка часов — во вкладке «По объектам». */
const DayCells: FC<IDayCellsProps> = ({ year, month, days, hoursByDate }) => (
  <>
    {days.map(day => {
      const hours = hoursByDate[isoDay(year, month, day)];
      const classes = ['ts-day', 'ts-salary-object-day'];
      if (hours !== undefined && hours > 0) classes.push('ts-day--full');
      else if (isWeekend(year, month, day)) classes.push('ts-day--weekend');
      if (isToday(year, month, day)) classes.push('ts-day--today');
      return <td key={day} className={classes.join(' ')}>{formatDayHours(hours)}</td>;
    })}
  </>
);

/**
 * «Табель → Зарплата по объектам» (миграция 336): рабочие бригады по объектам, как во вкладке «По объектам», у каждого
 * объекта — «Выработка, ₽»; доля на объекте — по КТУ × учтённые часы на нём. Внизу «Итого по бригаде»: доля по всем
 * объектам и «Сумма» к выплате.
 */
export const TimesheetSalaryObjects: FC<ITimesheetSalaryObjectsProps> = props => {
  const { data, loading, year, month, compact, canEdit, savingObjectKey, onObjectOutputSave } = props;
  const salary: ITimesheetSalaryGridProps = useMemo(() => ({
    data,
    canEdit,
    pendingKtuEmployeeId: props.pendingKtuEmployeeId,
    onKtuChange: props.onKtuChange,
  }), [data, canEdit, props.pendingKtuEmployeeId, props.onKtuChange]);
  const rows = useMemo(() => sortSalaryRows(data?.rows ?? []), [data]);
  const rowById = useMemo(() => new Map(rows.map(row => [row.employee_id, row])), [rows]);
  const order = useMemo(() => new Map(rows.map((row, index) => [row.employee_id, index])), [rows]);
  const days = useMemo(() => Array.from({ length: getDaysInMonth(year, month) }, (_, index) => index + 1), [year, month]);

  if (loading || !data) {
    return <div className="ts-table-container"><div className="ts-loading">Загрузка…</div></div>;
  }
  const objects = data.objects ?? [];
  const state = describeSalaryState(data);
  const muted = isSalaryRowMuted(data, rows[0] ?? null);
  const nameOf = (employeeId: number): string => rowById.get(employeeId)?.full_name ?? `№ ${employeeId}`;
  const header = (
    <div className="ts-table-header-bar ts-salary-objects-bar">
      <h3 className="ts-table-title">Зарплата по объектам</h3>
      <span className="ts-salary-objects-total">
        Выработка всего: <strong>{formatSalaryAmount(data.output_amount)}</strong>
      </span>
      {state && (
        <span className={`ts-salary-state ts-salary-state--${state.tone}`} title={state.title}>{state.text}</span>
      )}
    </div>
  );
  const outputField = (object: ITimesheetSalaryObject) => (
    <TimesheetSalaryOutputInput
      value={object.output_amount}
      canEdit={canEdit}
      saving={savingObjectKey === object.object_key}
      label={`Выработка, ${object.object_name}`}
      clearOnly={isOutputClearOnly(object)}
      onSave={amount => onObjectOutputSave(object.object_key, amount)}
    />
  );

  if (compact) {
    return (
      <div className="ts-table-container">
        {header}
        <TimesheetSalaryObjectsMobile
          data={data}
          rows={rows}
          salary={salary}
          muted={muted}
          nameOf={nameOf}
          order={order}
          outputField={outputField}
        />
      </div>
    );
  }

  const colSpan = days.length + 5;
  const totalHours = Math.round(objects.reduce((sum, object) => sum + object.total_hours, 0) * 100) / 100;
  return (
    <div className="ts-table-container">
      {header}
      <div className="ts-table-scroll">
        <table className="ts-table ts-table--objects ts-table--salary-objects">
          <thead>
            <tr>
              <th className="ts-col-sticky">Объект / сотрудник</th>
              <th className="ts-col-ktu-sticky" title="Коэффициент трудового участия, 0,5–2,0; один на месяц на всех объектах">КТУ</th>
              {days.map(day => (
                <th key={day} className={isToday(year, month, day) ? 'ts-th--today' : isWeekend(year, month, day) ? 'ts-th--weekend' : ''}>
                  {day}<br />
                  <span className="ts-th-weekday">{getWeekdayShort(year, month, day)}</span>
                </th>
              ))}
              <th className="ts-col-salary" title="Часть выработки объекта: выработка × КТУ × учтённые часы на объекте / Σ">Доля</th>
              <th className="ts-col-salary" title="К выплате: доля по всем объектам + доплаты − удержания, без НДФЛ">Сумма</th>
              <th className="ts-col-sum-sticky" title="Часы на объекте по табелю">Часы</th>
            </tr>
          </thead>
          <tbody>
            {objects.map(object => {
              const note = salaryObjectStateNote(object);
              const members = [...object.members].sort((a, b) => (
                (order.get(a.employee_id) ?? 0) - (order.get(b.employee_id) ?? 0)
              ));
              return (
                <Fragment key={object.object_key}>
                  <tr className="ts-object-group-row">
                    <td className="ts-col-sticky ts-object-group-cell" colSpan={colSpan}>
                      <div className="ts-salary-divider">
                        <span className="ts-object-group-name">{object.object_name}</span>
                        <span className="ts-object-group-meta">
                          {object.members.length} чел.{object.total_hours > 0 ? ` (${Math.round(object.total_hours)} ч.)` : ''}
                        </span>
                        <label className="ts-salary-output">
                          <span className="ts-salary-output-label">Выработка, ₽</span>
                          {outputField(object)}
                        </label>
                        {note && <span className="ts-salary-object-note">{note}</span>}
                      </div>
                    </td>
                  </tr>
                  {members.map(member => {
                    const row = rowById.get(member.employee_id);
                    return (
                      <tr key={`${object.object_key}_${member.employee_id}`}>
                        <td className="ts-col-sticky ts-object-employee-cell">
                          <div className="ts-object-employee-name" title={nameOf(member.employee_id)}>
                            {formatTimesheetEmployeeName(nameOf(member.employee_id))}
                          </div>
                        </td>
                        <td className="ts-col-ktu-sticky">
                          {row ? <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(member.employee_id)} /> : '—'}
                        </td>
                        <DayCells year={year} month={month} days={days} hoursByDate={member.days} />
                        <td
                          className={`ts-col-salary${muted && member.share ? ' ts-salary-amount--stale' : ''}`}
                          title={objectShareTitle(object, member)}
                        >
                          {formatSalaryAmount(member.share)}
                        </td>
                        <td className="ts-col-salary" />
                        <td className="ts-col-sum-sticky">{member.hours > 0 ? formatHoursLabel(member.hours) : '—'}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {objects.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="ts-loading">Нет часов бригады на объектах за месяц</td>
              </tr>
            )}
            {rows.length > 0 && (
              <>
                <tr className="ts-object-group-row ts-salary-total-row">
                  <td className="ts-col-sticky ts-object-group-cell" colSpan={colSpan}>
                    <div className="ts-salary-divider">
                      <span className="ts-object-group-name">Итого по бригаде</span>
                      <span className="ts-object-group-meta">
                        {rows.length} чел.{totalHours > 0 ? ` (${Math.round(totalHours)} ч.)` : ''}
                      </span>
                    </div>
                  </td>
                </tr>
                {rows.map(row => {
                  const totalDays = totalDaysOfEmployee(data, row.employee_id);
                  const hours = Object.values(totalDays).reduce((sum, value) => sum + value, 0);
                  return (
                    <tr key={`total_${row.employee_id}`}>
                      <td className="ts-col-sticky ts-object-employee-cell">
                        <div className="ts-object-employee-name" title={nameOf(row.employee_id)}>
                          {formatTimesheetEmployeeName(nameOf(row.employee_id))}
                        </div>
                      </td>
                      <td className="ts-col-ktu-sticky">
                        <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(row.employee_id)} />
                      </td>
                      <DayCells year={year} month={month} days={days} hoursByDate={totalDays} />
                      <td className={`ts-col-salary${muted && row.share ? ' ts-salary-amount--stale' : ''}`}>
                        {formatSalaryAmount(row.share ?? null)}
                      </td>
                      <td
                        className={`ts-col-salary${muted && row.amount ? ' ts-salary-amount--stale' : ''}`}
                        title={salaryAmountTitle(data, row)}
                      >
                        {formatSalaryAmount(row.amount)}
                      </td>
                      <td className="ts-col-sum-sticky">{hours > 0 ? formatHoursLabel(hours) : '—'}</td>
                    </tr>
                  );
                })}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
