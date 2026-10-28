import type { FC } from 'react';

import type { TimesheetEmployee } from '../../types';
import type { ITimesheetSalaryResponse, ITimesheetSalaryRow } from '../../types/timesheet';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import {
  findSalaryRow, formatKtu, formatSalaryAmount, salaryAmountTitle, salaryLineTitle, salaryOvertimeNote,
} from '../../utils/timesheetSalary';

/** Вкладка «Зарплата» в табеле: данные и правка КТУ / «Выработки». */
export interface ITimesheetSalaryGridProps {
  data: ITimesheetSalaryResponse | undefined;
  /** Право страницы «Зарплаты» на правку. */
  canEdit: boolean;
  savingOutput: boolean;
  pendingKtuEmployeeId: number | null;
  onKtuChange: (employeeId: number, ktu: number) => void;
  onOutputSave: (amount: number | null) => Promise<void>;
}

/** КТУ 0,5…2,0 с шагом 0,1. */
const KTU_OPTIONS = Array.from({ length: 16 }, (_, index) => ((index + 5) / 10).toFixed(1));

const amountTitle = (salary: ITimesheetSalaryGridProps, row: ITimesheetSalaryRow): string | undefined => (
  salary.data ? salaryAmountTitle(salary.data, row) : undefined
);

interface IKtuSelectProps {
  salary: ITimesheetSalaryGridProps;
  row: ITimesheetSalaryRow;
  employeeName: string;
}

export const TimesheetSalaryKtuSelect: FC<IKtuSelectProps> = ({ salary, row, employeeName }) => {
  const value = row.ktu ?? '1.0';
  const editable = salary.canEdit && row.can_edit;
  if (!editable) return <span className="ts-salary-ktu-text">{formatKtu(value)}</span>;
  return (
    <select
      className="ts-salary-ktu-select"
      value={value}
      disabled={salary.pendingKtuEmployeeId === row.employee_id}
      aria-label={`КТУ: ${employeeName}`}
      onClick={event => event.stopPropagation()}
      onChange={event => salary.onKtuChange(row.employee_id, Number(event.target.value))}
    >
      {KTU_OPTIONS.map(option => (
        <option key={option} value={option}>{formatKtu(option)}</option>
      ))}
    </select>
  );
};

interface ICellProps {
  salary: ITimesheetSalaryGridProps;
  employee: TimesheetEmployee;
}

export const TimesheetSalaryKtuCell: FC<ICellProps> = ({ salary, employee }) => {
  const row = findSalaryRow(salary.data, employee);
  return (
    <td className="ts-col-ktu-sticky">
      {row
        ? <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={formatTimesheetEmployeeName(employee.full_name)} />
        : '—'}
    </td>
  );
};

export const TimesheetSalaryAmountCell: FC<ICellProps> = ({ salary, employee }) => {
  const row = findSalaryRow(salary.data, employee);
  const stale = salary.data?.state === 'stale';
  return (
    <td
      className={`ts-col-salary${stale && row?.amount ? ' ts-salary-amount--stale' : ''}`}
      title={row ? amountTitle(salary, row) : undefined}
    >
      {formatSalaryAmount(row?.amount ?? null)}
    </td>
  );
};

type SalaryLineCode = 'contract' | 'overtime';

/** «Оклад» / «Переработка» отдела — строки расчёта «Суммы»; у «Переработки» под суммой — часы и выходы. */
export const TimesheetSalaryLineCell: FC<ICellProps & { code: SalaryLineCode }> = ({ salary, employee, code }) => {
  const row = findSalaryRow(salary.data, employee);
  const line = row?.[code];
  const note = salaryOvertimeNote(line);
  return (
    <td className="ts-col-salary" title={row ? salaryLineTitle(row, line) : undefined}>
      {formatSalaryAmount(line?.amount ?? null)}
      {note && <span className="ts-salary-line-note">{note}</span>}
    </td>
  );
};

/** Клетка «УУ» / «РБ» / «УД» вкладки «Зарплата»: сверху буква, под чертой — часы (правки «УУ» или по графику). */
export const TimesheetLetterFraction: FC<{ label: string; hours: number }> = ({ label, hours }) => (
  <span className="ts-day-fraction">
    <span>{label}</span>
    <span className="ts-day-fraction-hours">{hours}</span>
  </span>
);

/** Мобильная карточка: КТУ (бригада) или «Оклад» и «Переработка» (отдел) и «Сумма» строкой под ФИО. */
export const TimesheetSalaryMobileRow: FC<ICellProps> = ({ salary, employee }) => {
  const row = findSalaryRow(salary.data, employee);
  if (!row) return null;
  const isBrigade = salary.data?.kind === 'brigade';
  return (
    <div className="ts-salary-mobile-row">
      {isBrigade && (
        <label className="ts-salary-mobile-field">
          <span>КТУ</span>
          <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={formatTimesheetEmployeeName(employee.full_name)} />
        </label>
      )}
      {!isBrigade && ([['contract', 'Оклад'], ['overtime', 'Переработка']] as const).map(([code, label]) => {
        const note = salaryOvertimeNote(row[code]);
        return (
          <span key={code} className="ts-salary-mobile-field" title={salaryLineTitle(row, row[code])}>
            {label}
            <span className="ts-salary-mobile-line">
              {formatSalaryAmount(row[code]?.amount ?? null)}
              {note && <span className="ts-salary-line-note"> · {note}</span>}
            </span>
          </span>
        );
      })}
      <span
        className={`ts-salary-mobile-amount${salary.data?.state === 'stale' && row.amount ? ' ts-salary-amount--stale' : ''}`}
        title={amountTitle(salary, row)}
      >
        {formatSalaryAmount(row.amount)}
      </span>
    </div>
  );
};
