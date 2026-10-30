import { useMemo, type FC } from 'react';

import type { ITimesheetSalaryObject, ITimesheetSalaryResponse } from '../../types/timesheet';
import { isOutputClearOnly, isSalaryRowMuted, sortSalaryRows } from '../../utils/timesheetSalary';
import { salaryTotalRows } from '../../utils/timesheetSalaryOverlay';
import type { ITimesheetSalaryGridProps } from './TimesheetSalaryCells';
import { TimesheetGrid, type ITimesheetGridProps } from './TimesheetGrid';
import { TimesheetSalaryObjectsHeader, type ITimesheetObjectsSalary } from './TimesheetSalaryObjectsParts';
import { TimesheetSalaryObjectsMobile } from './TimesheetSalaryObjectsMobile';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';

/** Данные сетки «По объектам» — те же, что у вкладки «По объектам»; режим и правки задаёт эта вкладка. */
export type TimesheetSalaryObjectsGridProps = Omit<
  ITimesheetGridProps,
  'viewMode' | 'compact' | 'bulkEditMode' | 'readOnly' | 'salary' | 'objectsSalary'
>;

export interface ITimesheetSalaryObjectsProps {
  data: ITimesheetSalaryResponse | undefined;
  loading: boolean;
  error: boolean;
  /** null — табеля ещё нет. */
  grid: TimesheetSalaryObjectsGridProps | null;
  /** Табель ещё не пришёл для текущих бригады и месяца (в том числе показан прошлый). */
  gridLoading: boolean;
  gridError: boolean;
  compact: boolean;
  /** «Все сотрудники»: в «Итого по бригаде» весь состав; выключено — только те, у кого есть часы. */
  showAllEmployees: boolean;
  canEdit: boolean;
  pendingKtuEmployeeId: number | null;
  savingObjectKey: string | null;
  onKtuChange: (employeeId: number, ktu: number) => void;
  onObjectOutputSave: (objectKey: string, amount: number | null) => Promise<void>;
}

const Message: FC<{ text: string }> = ({ text }) => (
  <div className="ts-table-container"><div className="ts-loading">{text}</div></div>
);

/**
 * «Табель → Зарплата по объектам» (миграция 336). Десктоп — сетка «По объектам» как есть, только просмотр, с КТУ,
 * «Выработкой, ₽» у объекта, «Долей» и «Итого по бригаде»; доля на объекте — по КТУ × учтённые часы на нём.
 * Телефон — карточки объектов.
 */
export const TimesheetSalaryObjects: FC<ITimesheetSalaryObjectsProps> = props => {
  const { data, loading, error, grid, gridLoading, gridError, compact, showAllEmployees, canEdit } = props;
  const objectsSalary = useMemo<ITimesheetObjectsSalary | null>(() => (data ? {
    data,
    canEdit,
    showAllEmployees,
    pendingKtuEmployeeId: props.pendingKtuEmployeeId,
    savingObjectKey: props.savingObjectKey,
    onKtuChange: props.onKtuChange,
    onObjectOutputSave: props.onObjectOutputSave,
  } : null), [
    data, canEdit, showAllEmployees, props.pendingKtuEmployeeId, props.savingObjectKey, props.onKtuChange,
    props.onObjectOutputSave,
  ]);
  const rows = useMemo(() => sortSalaryRows(data?.rows ?? []), [data]);
  const order = useMemo(() => new Map(rows.map((row, index) => [row.employee_id, index])), [rows]);

  if (error) return <Message text="Не удалось загрузить расчёт" />;
  if (!compact && gridError) return <Message text="Не удалось загрузить табель" />;
  if (loading || !data || !objectsSalary) return <Message text="Загрузка…" />;

  if (!compact) {
    if (gridLoading || !grid) return <Message text="Загрузка…" />;
    return <TimesheetGrid {...grid} viewMode="objects" readOnly objectsSalary={objectsSalary} />;
  }

  const salary: ITimesheetSalaryGridProps = objectsSalary;
  const rowById = new Map(rows.map(row => [row.employee_id, row]));
  const nameOf = (employeeId: number): string => rowById.get(employeeId)?.full_name ?? `№ ${employeeId}`;
  const outputField = (object: ITimesheetSalaryObject) => (
    <TimesheetSalaryOutputInput
      value={object.output_amount}
      canEdit={canEdit}
      saving={props.savingObjectKey === object.object_key}
      label={`Выработка, ${object.object_name}`}
      clearOnly={isOutputClearOnly(object)}
      onSave={amount => props.onObjectOutputSave(object.object_key, amount)}
    />
  );
  return (
    <div className="ts-table-container">
      <div className="ts-table-header-bar ts-salary-objects-bar">
        <TimesheetSalaryObjectsHeader data={data} />
      </div>
      <TimesheetSalaryObjectsMobile
        data={data}
        rows={rows}
        totalRows={salaryTotalRows(rows, data, showAllEmployees)}
        salary={salary}
        muted={isSalaryRowMuted(data, rows[0] ?? null)}
        nameOf={nameOf}
        order={order}
        outputField={outputField}
      />
    </div>
  );
};
