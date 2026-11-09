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
  averageTitle,
  BRIGADE_SHARE_KEY,
  countedHoursLabel,
  describeSalaryState,
  displayedHours,
  employeeCountedMinutes,
  formatKtu,
  formatSalaryAmount,
  isFixedShare,
  isOutputClearOnly,
  isSalaryRowMuted,
  memberAverage,
  objectAverage,
  objectCountedMinutes,
  objectShareMode,
  objectShareTitle,
  rowAverage,
  salaryAmountTitle,
  salaryObjectStateNote,
  shareConflictsOf,
  shareConflictText,
  shareFieldValue,
  sortSalaryRows,
  totalDaysOfEmployee,
  totalShareMode,
} from '../../utils/timesheetSalary';
import { salaryTotalRows } from '../../utils/timesheetSalaryOverlay';
import { TimesheetSalaryKtuSelect } from './TimesheetSalaryCells';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';

/** «Зарплата по объектам» поверх сетки «По объектам»: расчёт бригады и его правка (КТУ, «Выработка, ₽», «Доля»). */
export interface ITimesheetObjectsSalary {
  data: ITimesheetSalaryResponse;
  canEdit: boolean;
  /** «Все сотрудники»: в «Итого по бригаде» весь состав; выключено — только те, у кого есть часы. */
  showAllEmployees: boolean;
  pendingKtuEmployeeId: number | null;
  savingObjectKey: string | null;
  /** Сохраняемая «Доля»: `${object_key}:${employee_id}`. */
  savingShareKey: string | null;
  onKtuChange: (employeeId: number, ktu: number) => void;
  onObjectOutputSave: (objectKey: string, amount: number | null) => Promise<void>;
  /** «Доля», вписанная рублями (355): object_key ('__brigade__' — сумма бригаде); null — стереть. */
  onShareSave: (objectKey: string, employeeId: number, amount: number | null) => Promise<void>;
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

/** Выработка внесена одной суммой на бригаду (341): у объектов полей нет — «или — или», правка во «Бригадах». */
const isBrigadeOutput = (data: ITimesheetSalaryResponse): boolean => data.output_mode === 'brigade';

const amountClass = (muted: boolean, amount: string | null | undefined): string => (
  `ts-col-salary${muted && amount ? ' ts-salary-amount--stale' : ''}`
);

const hoursLabel = (hours: number): string => (hours > 0 ? formatHoursLabel(hours) : '—');

/**
 * Шапка вкладки: заголовок, «Выработка всего» (по объектам) или «Выработка бригады» (одной суммой), состояние; у суммы
 * бригаде — и пометка, если вписанные доли не сходятся (по объектам она у своего объекта).
 */
export const TimesheetSalaryObjectsHeader: FC<{ data: ITimesheetSalaryResponse }> = ({ data }) => {
  const state = describeSalaryState(data);
  const conflicts = isBrigadeOutput(data) ? shareConflictsOf(data, BRIGADE_SHARE_KEY) : [];
  return (
    <div className="ts-salary-objects-head">
      <h3 className="ts-table-title">Зарплата по объектам</h3>
      <span className="ts-salary-objects-total">
        {isBrigadeOutput(data) ? 'Выработка бригады' : 'Выработка всего'}:{' '}
        <strong>{formatSalaryAmount(data.output_amount)}</strong>
      </span>
      {state && (
        <span className={`ts-salary-state ts-salary-state--${state.tone}`} title={state.title}>{state.text}</span>
      )}
      {conflicts.length > 0 && (
        <span className="ts-salary-state ts-salary-state--error">
          Долей нет: {conflicts.map(shareConflictText).join('; ')}
        </span>
      )}
    </div>
  );
};

interface ISalaryProps {
  salary: ITimesheetObjectsSalary;
}

/** «Выработка, ₽» объекта расчёта в строке группы и его средняя в час; объекта в расчёте нет или сумма бригаде — ничего. */
export const TimesheetSalaryGroupOutput: FC<ISalaryProps & { object: ITimesheetSalaryObject | undefined }> = ({
  salary, object,
}) => {
  if (!object || isBrigadeOutput(salary.data)) return null;
  const note = salaryObjectStateNote(object, shareConflictsOf(salary.data, object.object_key));
  const average = objectAverage(object);
  const minutes = objectCountedMinutes(object);
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
      {average !== null && (
        <span className="ts-salary-output" title={averageTitle(object.output_amount, minutes)}>
          <span className="ts-salary-output-label">Учтено</span>
          <span className="ts-salary-output-value">{countedHoursLabel(minutes)}</span>
          <span className="ts-salary-output-label">Средняя, ₽/ч</span>
          <span className={`ts-salary-output-value${isMuted(salary.data) ? ' ts-salary-amount--stale' : ''}`}>
            {formatSalaryAmount(average)}
          </span>
        </span>
      )}
    </span>
  );
};

const HAS_FIXED_TITLE = 'На объектах есть вписанные доли: там КТУ — по доле';

/**
 * КТУ сотрудника бригады; не участник расчёта (начальник участка) — «—». В строке объекта с вписанной долей — расчётный
 * КТУ по ней; в «Итого по бригаде» — КТУ месяца (у суммы бригаде с вписанной долей — расчётный).
 */
export const TimesheetSalaryKtuCell: FC<ISalaryProps & { employeeId: number; object?: ITimesheetSalaryObject }> = ({
  salary, employeeId, object,
}) => {
  const row = salaryRowOf(salary.data, employeeId);
  const member = object?.members.find(item => item.employee_id === employeeId);
  const fixedKtu = object
    ? (member && isFixedShare(member) ? { ktu: member.effective_ktu ?? null } : undefined)
    : (row && isBrigadeOutput(salary.data) && isFixedShare(row) ? { ktu: row.effective_ktu ?? null } : undefined);
  const title = !object && row?.has_fixed_shares ? HAS_FIXED_TITLE : undefined;
  return (
    <td className="ts-col-ktu-sticky">
      {row
        ? <TimesheetSalaryKtuSelect salary={salary} row={row} employeeName={nameOf(salary.data, employeeId)} fixedKtu={fixedKtu} title={title} />
        : '—'}
    </td>
  );
};

/** Подсказка вписанной доли «Итого по бригаде» (сумма бригаде). */
const rowShareTitle = (row: ITimesheetSalaryRow): string | undefined => {
  if (!isFixedShare(row)) return undefined;
  if (row.share === null || row.share === undefined) return 'Доля вписана вручную — не сходится с выработкой';
  return `Доля вписана вручную${row.effective_ktu ? ` · КТУ ${formatKtu(row.effective_ktu)}` : ''}`;
};

/**
 * Поле «Доли» (355): вписанная — жирным; посчитанная по формуле — как есть, правка её закрепляет. Стереть посчитанную
 * нечего — крестик у неё ничего не отправляет. clear — только стереть вписанную (нет часов, ушёл из бригады).
 */
export const TimesheetSalaryShareField: FC<ISalaryProps & {
  objectKey: string;
  employeeId: number;
  value: { fixed_share?: string | null; share?: string | null };
  mode: 'edit' | 'clear';
  title: string | undefined;
}> = ({ salary, objectKey, employeeId, value, mode, title }) => {
  const fixed = isFixedShare(value);
  return (
    <TimesheetSalaryOutputInput
      value={shareFieldValue(value)}
      canEdit
      saving={salary.savingShareKey === `${objectKey}:${employeeId}`}
      label={`Доля, ${nameOf(salary.data, employeeId)}`}
      clearOnly={mode === 'clear'}
      className={`ts-salary-share-input${fixed ? ' ts-salary-share-input--fixed' : ''}`}
      title={title}
      onSave={async amount => {
        if (amount === null && !fixed) return;
        await salary.onShareSave(objectKey, employeeId, amount);
      }}
    />
  );
};

/** «Доля» сотрудника на объекте группы, пустая «Сумма» (она — в «Итого по бригаде») и «Средняя». */
export const TimesheetSalaryShareCells: FC<ISalaryProps & {
  object: ITimesheetSalaryObject | undefined;
  employeeId: number;
}> = ({ salary, object, employeeId }) => {
  const member = object?.members.find(item => item.employee_id === employeeId) ?? null;
  const muted = isMuted(salary.data);
  const average = member ? memberAverage(member) : null;
  const title = object && member ? objectShareTitle(object, member) : undefined;
  const mode = object && member ? objectShareMode(salary.data, salary.canEdit, object, member) : null;
  return (
    <>
      <td className={amountClass(muted, member?.share)} title={mode ? undefined : title}>
        {object && member && mode
          ? (
            <TimesheetSalaryShareField
              salary={salary} objectKey={object.object_key} employeeId={employeeId} value={member} mode={mode} title={title}
            />
          )
          : formatSalaryAmount(member?.share ?? null)}
      </td>
      <td className="ts-col-salary" />
      <td className={amountClass(muted, average)} title={member ? averageTitle(member.share, member.counted_minutes) : undefined}>
        {formatSalaryAmount(average)}
      </td>
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
            <TimesheetSalaryKtuCell salary={salary} employeeId={member.employee_id} object={object} />
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

/** «Доля» в «Итого по бригаде»: по объектам — Σ, только показ; при сумме бригаде — поле, как у объекта. */
const TotalShareCell: FC<ISalaryProps & { row: ITimesheetSalaryRow; muted: boolean }> = ({ salary, row, muted }) => {
  const mode = totalShareMode(salary.data, salary.canEdit, row);
  const title = rowShareTitle(row);
  return (
    <td className={amountClass(muted, row.share)} title={mode ? undefined : title}>
      {mode
        ? (
          <TimesheetSalaryShareField
            salary={salary} objectKey={BRIGADE_SHARE_KEY} employeeId={row.employee_id} value={row} mode={mode} title={title}
          />
        )
        : formatSalaryAmount(row.share ?? null)}
    </td>
  );
};

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
        const average = rowAverage(data, row);
        return (
          <tr key={`total_${row.employee_id}`}>
            <td className="ts-col-sticky ts-object-employee-cell">
              <div className="ts-object-employee-name" title={name}>{formatTimesheetEmployeeName(name)}</div>
            </td>
            <TimesheetSalaryKtuCell salary={salary} employeeId={row.employee_id} />
            {days.cells}
            <TotalShareCell salary={salary} row={row} muted={muted} />
            <td className={amountClass(muted, row.amount)} title={salaryAmountTitle(data, row)}>
              {formatSalaryAmount(row.amount)}
            </td>
            <td className={amountClass(muted, average)} title={averageTitle(row.share, employeeCountedMinutes(data, row.employee_id))}>
              {formatSalaryAmount(average)}
            </td>
            <td className="ts-col-sum-sticky">{hoursLabel(days.hours)}</td>
          </tr>
        );
      })}
    </>
  );
};
