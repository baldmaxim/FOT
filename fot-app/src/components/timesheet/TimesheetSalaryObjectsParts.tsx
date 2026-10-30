import { Fragment, type FC, type ReactNode } from 'react';

import type {
  ITimesheetSalaryObject,
  ITimesheetSalaryObjectMember,
  ITimesheetSalaryResponse,
  ITimesheetSalaryRow,
} from '../../types/timesheet';
import { formatHoursLabel } from '../../utils/hoursDisplay';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import {
  describeSalaryState,
  displayedHours,
  formatSalaryAmount,
  isOutputClearOnly,
  isSalaryRowMuted,
  objectShareTitle,
  salaryAmountTitle,
  salaryObjectStateNote,
  sortSalaryRows,
  totalDaysOfEmployee,
} from '../../utils/timesheetSalary';
import { salaryTotalRows } from '../../utils/timesheetSalaryOverlay';
import { TimesheetSalaryKtuSelect } from './TimesheetSalaryCells';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';

/** «Зарплата по объектам» поверх сетки «По объектам»: расчёт бригады и его правка (КТУ, «Выработка, ₽»). */
export interface ITimesheetObjectsSalary {
  data: ITimesheetSalaryResponse;
  canEdit: boolean;
  /** «Все сотрудники»: в «Итого по бригаде» весь состав; выключено — только те, у кого есть часы. */
  showAllEmployees: boolean;
  pendingKtuEmployeeId: number | null;
  savingObjectKey: string | null;
  onKtuChange: (employeeId: number, ktu: number) => void;
  onObjectOutputSave: (objectKey: string, amount: number | null) => Promise<void>;
}

/**
 * Клетки дней в стиле сетки, только просмотр: preferTimesheet и строка табеля есть — как «По сотрудникам»; иначе часы
 * расчёта целыми (дня в расчёте нет — что в табеле). hours — сумма показанных цифр.
 */
export type SalaryDaysRenderer = (
  employeeId: number,
  calcHours: Record<string, number>,
  preferTimesheet: boolean,
) => { cells: ReactNode; hours: number };

const salaryRowOf = (data: ITimesheetSalaryResponse, employeeId: number): ITimesheetSalaryRow | null => (
  data.rows.find(row => row.employee_id === employeeId) ?? null
);

const nameOf = (data: ITimesheetSalaryResponse, employeeId: number): string => (
  salaryRowOf(data, employeeId)?.full_name ?? `№ ${employeeId}`
);

const isMuted = (data: ITimesheetSalaryResponse): boolean => isSalaryRowMuted(data, data.rows[0] ?? null);

const amountClass = (muted: boolean, amount: string | null | undefined): string => (
  `ts-col-salary${muted && amount ? ' ts-salary-amount--stale' : ''}`
);

const hoursLabel = (hours: number): string => (hours > 0 ? formatHoursLabel(hours) : '—');

/** Шапка вкладки: заголовок, «Выработка всего», состояние расчёта. */
export const TimesheetSalaryObjectsHeader: FC<{ data: ITimesheetSalaryResponse }> = ({ data }) => {
  const state = describeSalaryState(data);
  return (
    <div className="ts-salary-objects-head">
      <h3 className="ts-table-title">Зарплата по объектам</h3>
      <span className="ts-salary-objects-total">
        Выработка всего: <strong>{formatSalaryAmount(data.output_amount)}</strong>
      </span>
      {state && (
        <span className={`ts-salary-state ts-salary-state--${state.tone}`} title={state.title}>{state.text}</span>
      )}
    </div>
  );
};

interface ISalaryProps {
  salary: ITimesheetObjectsSalary;
}

/** «Выработка, ₽» объекта расчёта в строке группы; объекта в расчёте нет — ничего. */
export const TimesheetSalaryGroupOutput: FC<ISalaryProps & { object: ITimesheetSalaryObject | undefined }> = ({
  salary, object,
}) => {
  if (!object) return null;
  const note = salaryObjectStateNote(object);
  return (
    <span className="ts-salary-group-output">
      <label className="ts-salary-output">
        <span className="ts-salary-output-label">Выработка, ₽</span>
        <TimesheetSalaryOutputInput
          value={object.output_amount}
          canEdit={salary.canEdit}
          saving={salary.savingObjectKey === object.object_key}
          label={`Выработка, ${object.object_name}`}
          clearOnly={isOutputClearOnly(object)}
          onSave={amount => salary.onObjectOutputSave(object.object_key, amount)}
        />
      </label>
      {note && <span className="ts-salary-object-note">{note}</span>}
    </span>
  );
};

/** КТУ сотрудника бригады; не участник расчёта (начальник участка) — «—». */
export const TimesheetSalaryKtuCell: FC<ISalaryProps & { employeeId: number }> = ({ salary, employeeId }) => {
  const row = salaryRowOf(salary.data, employeeId);
  return (
    <td className="ts-col-ktu-sticky">
      {row ? <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(salary.data, employeeId)} /> : '—'}
    </td>
  );
};

/** «Доля» сотрудника на объекте группы и пустая «Сумма» (она — в «Итого по бригаде»). */
export const TimesheetSalaryShareCells: FC<ISalaryProps & {
  object: ITimesheetSalaryObject | undefined;
  employeeId: number;
}> = ({ salary, object, employeeId }) => {
  const member = object?.members.find(item => item.employee_id === employeeId) ?? null;
  return (
    <>
      <td
        className={amountClass(isMuted(salary.data), member?.share)}
        title={object && member ? objectShareTitle(object, member) : undefined}
      >
        {formatSalaryAmount(member?.share ?? null)}
      </td>
      <td className="ts-col-salary" />
    </>
  );
};

interface ICalcRowsProps extends ISalaryProps {
  object: ITimesheetSalaryObject;
  members: readonly ITimesheetSalaryObjectMember[];
  renderDays: SalaryDaysRenderer;
}

/** Строки «только в расчёте»: доля есть, а строки в табеле «По объектам» нет — часы расчёта, светло-серым. */
export const TimesheetSalaryCalcRows: FC<ICalcRowsProps> = ({ salary, object, members, renderDays }) => {
  const order = new Map(sortSalaryRows(salary.data.rows).map((row, index) => [row.employee_id, index]));
  const sorted = [...members].sort((a, b) => (
    (order.get(a.employee_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.employee_id) ?? Number.MAX_SAFE_INTEGER)
    || a.employee_id - b.employee_id
  ));
  return (
    <>
      {sorted.map(member => {
        const name = nameOf(salary.data, member.employee_id);
        const days = renderDays(member.employee_id, member.days, false);
        return (
          <tr key={`calc_${object.object_key}_${member.employee_id}`} className="ts-salary-calc-row">
            <td className="ts-col-sticky ts-object-employee-cell">
              <div className="ts-object-employee-name" title={`${name} — только в расчёте зарплаты`}>
                {formatTimesheetEmployeeName(name)}
              </div>
            </td>
            <TimesheetSalaryKtuCell salary={salary} employeeId={member.employee_id} />
            {days.cells}
            <TimesheetSalaryShareCells salary={salary} object={object} employeeId={member.employee_id} />
            <td className="ts-col-sum-sticky">{hoursLabel(days.hours)}</td>
          </tr>
        );
      })}
    </>
  );
};

interface ISectionProps extends ISalaryProps {
  colSpan: number;
  renderDays: SalaryDaysRenderer;
}

/** Объекты расчёта без группы в табеле («Текущая деятельность», закреплённый объект) — свои группы под табелем. */
export const TimesheetSalaryCalcGroups: FC<ISectionProps & { objects: readonly ITimesheetSalaryObject[] }> = ({
  salary, objects, colSpan, renderDays,
}) => (
  <>
    {objects.map(object => {
      const hours = object.members.reduce((sum, member) => sum + displayedHours(member.days), 0);
      return (
        <Fragment key={`calc_${object.object_key}`}>
          <tr className="ts-object-group-row">
            <td className="ts-col-sticky ts-object-group-cell" colSpan={colSpan}>
              <span className="ts-object-group-name">{object.object_name}</span>
              <span className="ts-object-group-meta">
                {object.members.length} чел.{hours > 0 ? ` (${hours} ч.)` : ''}
              </span>
              <TimesheetSalaryGroupOutput salary={salary} object={object} />
            </td>
          </tr>
          <TimesheetSalaryCalcRows salary={salary} object={object} members={object.members} renderDays={renderDays} />
        </Fragment>
      );
    })}
  </>
);

/** «Итого по бригаде»: каждый участник расчёта один раз — клетки как «По сотрудникам», доля по всем объектам и «Сумма». */
export const TimesheetSalaryTotalRows: FC<ISectionProps> = ({ salary, colSpan, renderDays }) => {
  const { data } = salary;
  const rows = salaryTotalRows(sortSalaryRows(data.rows), data, salary.showAllEmployees);
  if (rows.length === 0) return null;
  const muted = isMuted(data);
  const rendered = rows.map(row => ({
    row,
    days: renderDays(row.employee_id, totalDaysOfEmployee(data, row.employee_id), true),
  }));
  const totalHours = rendered.reduce((sum, item) => sum + item.days.hours, 0);
  return (
    <>
      <tr className="ts-object-group-row ts-salary-total-row">
        <td className="ts-col-sticky ts-object-group-cell" colSpan={colSpan}>
          <span className="ts-object-group-name">Итого по бригаде</span>
          <span className="ts-object-group-meta">
            {rows.length} чел.{totalHours > 0 ? ` (${totalHours} ч.)` : ''}
          </span>
        </td>
      </tr>
      {rendered.map(({ row, days }) => {
        const name = nameOf(data, row.employee_id);
        return (
          <tr key={`total_${row.employee_id}`}>
            <td className="ts-col-sticky ts-object-employee-cell">
              <div className="ts-object-employee-name" title={name}>{formatTimesheetEmployeeName(name)}</div>
            </td>
            <TimesheetSalaryKtuCell salary={salary} employeeId={row.employee_id} />
            {days.cells}
            <td className={amountClass(muted, row.share)}>{formatSalaryAmount(row.share ?? null)}</td>
            <td className={amountClass(muted, row.amount)} title={salaryAmountTitle(data, row)}>
              {formatSalaryAmount(row.amount)}
            </td>
            <td className="ts-col-sum-sticky">{hoursLabel(days.hours)}</td>
          </tr>
        );
      })}
    </>
  );
};
