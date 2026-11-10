import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import type {
  IPlannedDeduction,
  IPlannedDeductionApi,
  IStaffDeduction,
  IStaffDeductionKind,
} from '../../../services/staffDeductionService';
import { invalidateDeductionQueries } from '../../../utils/deductionQueries';
import { formatMonthLabel } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { EMPLOYEE_ROW_GROUP } from '../../../utils/payrollRegistries';
import {
  buildDeductionMonthExport,
  buildDeductionMonthRows,
  buildPlannedDeductionExport,
  DEDUCTION_MONTH_COLUMNS,
  PLANNED_DEDUCTION_COLUMNS,
  plannedDeductionRemovalQuestion,
  type IDeductionMonthRow,
} from '../../../utils/plannedDeductionTable';
import { staffDeductionKindLabel } from '../../../utils/staffDeductionTable';
import type { ITableExportSnapshot } from '../../../utils/tableView';
import { RegistryPanel, type IRegistryToolbarAction } from '../../ui/registry/RegistryPanel';
import { RegistryTabs, type IRegistryTab } from '../../ui/registry/RegistryTabs';
import tabStyles from '../../ui/registry/RegistryTabs.module.css';
import { PlannedDeductionForm, type IPlannedDeductionEditorApi } from './PlannedDeductionForm';
import { StaffDeductionModal, type IStaffDeductionEditorApi } from './StaffDeductionModal';

type DeductionTab = 'month' | 'planned';

const DEDUCTION_TABS: ReadonlyArray<IRegistryTab<DeductionTab>> = [
  { key: 'month', label: 'Удержания за месяц' },
  { key: 'planned', label: 'Плановые удержания' },
];

type ExportSender = (snapshot: ITableExportSnapshot) => Promise<{ blob: Blob; filename: string }>;

/** Чем раздел (кадры или «Зарплата») отличается: свои пути, права, ключи запросов и выгрузки; записи одни. */
export interface IDeductionRegistryApi<Staff extends IStaffDeduction> {
  /** Префиксы ключей запросов раздела: помесячные и плановые. */
  staffKey: readonly unknown[];
  plannedKey: readonly unknown[];
  /** Помесячные выбранных месяцев (months — значения YYYY-MM, param — ?months=). */
  listStaff: (months: { value: string[]; param: string }, signal: AbortSignal) => Promise<Staff[]>;
  /** Можно ли ✎ и 🗑 помесячной строки (в «Зарплате» — can_edit строки). */
  canEditStaff: (row: Staff) => boolean;
  removeStaff: (id: number) => Promise<void>;
  staffEditor: IStaffDeductionEditorApi;
  planned: IPlannedDeductionApi;
  /** Поиск «Добавить сотрудника» планового — тот же, что у помесячного. */
  plannedEditor: IPlannedDeductionEditorApi;
  exportMonth: ExportSender;
  exportPlanned: ExportSender;
}

interface IDeductionRegistryTabsProps<Staff extends IStaffDeduction> {
  api: IDeductionRegistryApi<Staff>;
  /** Право правки раздела: «Добавить сотрудника», ✎ и 🗑. */
  canEdit: boolean;
  kinds: readonly IStaffDeductionKind[];
  /** Внутри окна «Справочника»: фильтры и формы поверх окна, таблица прокручивается внутри. */
  raised?: boolean;
  /** «Виды удержаний» у кадров — на обеих вкладках. */
  toolbarAction?: IRegistryToolbarAction;
  /** Открыто ли поверх что-то своё (фильтр, окно правки): окно «Справочника» тогда не закрывается по Escape. */
  onOverlayChange?: (open: boolean) => void;
}

type EditorState =
  | { mode: 'add-staff' }
  | { mode: 'add-planned' }
  | { mode: 'staff'; row: IStaffDeduction }
  | { mode: 'planned'; row: IPlannedDeduction }
  | null;

const rowName = (row: { full_name: string }): string => row.full_name;
const monthRowKey = (row: IDeductionMonthRow): string => row.key;
const plannedRowKey = (row: IPlannedDeduction): string => `planned:${row.id}`;
const canEditMonthRow = (row: IDeductionMonthRow): boolean => row.can_edit;
const canEditPlannedRow = (row: IPlannedDeduction): boolean => row.can_edit;

/**
 * «Удержания» кадров и «Справочника» «Зарплаты» (миграции 321, 357) — вкладки одного окна, месяц общий, поиск и
 * фильтры у каждой свои. «Удержания за месяц» — помесячные и плановые выбранных месяцев (плановые сервер
 * разворачивает тем же SQL, что и расчёт), столбец «Тип»; «Добавить сотрудника» — помесячное. «Плановые удержания» —
 * периоды; «Убрать» идущее закрывает месяцем перед текущим (прошлые месяцы остаются), остальное удаляет.
 */
export const DeductionRegistryTabs = <Staff extends IStaffDeduction,>({
  api, canEdit, kinds, raised = false, toolbarAction, onOverlayChange,
}: IDeductionRegistryTabsProps<Staff>): ReactElement => {
  const tabsId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const months = useRegistryMonths();
  const [tab, setTab] = useState<DeductionTab>('month');
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const tabId = (key: DeductionTab) => `${tabsId}-tab-${key}`;
  const panelId = (key: DeductionTab) => `${tabsId}-panel-${key}`;

  useEffect(() => {
    onOverlayChange?.(filterOpen || editor !== null);
  }, [filterOpen, editor, onOverlayChange]);

  const staff = useQuery({
    queryKey: [...api.staffKey, 'month', months.param],
    queryFn: ({ signal }) => api.listStaff({ value: months.value, param: months.param }, signal),
    staleTime: 0,
  });
  const plannedByMonth = useQuery({
    queryKey: [...api.plannedKey, 'by-month', months.param],
    queryFn: ({ signal }) => api.planned.listByMonth(months.param, signal),
    staleTime: 0,
  });
  const planned = useQuery({
    queryKey: [...api.plannedKey, 'periods', months.param],
    queryFn: ({ signal }) => api.planned.list(months.param, signal),
    staleTime: 0,
  });
  const monthRows = useMemo(
    () => buildDeductionMonthRows(staff.data, plannedByMonth.data, api.canEditStaff),
    [staff.data, plannedByMonth.data, api.canEditStaff],
  );

  // Записи общие с другим разделом и входят во все расчёты: перечитать всё, где видны удержания.
  const refresh = () => invalidateDeductionQueries(queryClient);

  const runRemoval = async (key: string, question: string, remove: () => Promise<unknown>) => {
    if (busyKey !== null || !window.confirm(question)) return;
    setBusyKey(key);
    try {
      await remove();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };
  const removeStaff = (row: IStaffDeduction, key: string) => runRemoval(
    key,
    `Удалить удержание: ${row.full_name}, ${staffDeductionKindLabel(row)}, ${formatMonthLabel(row.month)}?`,
    () => api.removeStaff(row.id),
  );
  const removePlanned = (row: IPlannedDeduction, key: string) => runRemoval(
    key,
    plannedDeductionRemovalQuestion(row, moscowTodayIso()),
    () => api.planned.remove(row),
  );

  const editMonthRow = (row: IDeductionMonthRow) => {
    if (row.planned) setEditor({ mode: 'planned', row: row.planned });
    else if (row.staff) setEditor({ mode: 'staff', row: row.staff });
  };
  const deleteMonthRow = (row: IDeductionMonthRow) => {
    if (row.planned) void removePlanned(row.planned, row.key);
    else if (row.staff) void removeStaff(row.staff, row.key);
  };

  const panelProps = (key: DeductionTab) => ({
    className: tabStyles.tabPanel,
    role: 'tabpanel',
    id: panelId(key),
    'aria-labelledby': tabId(key),
    hidden: tab !== key,
    // В окне «Справочника» таблица прокручивается внутри, шапка закреплена (RegistryTable.module.css).
    ...(raised ? { 'data-registry-fill': true } : {}),
  });

  return (
    <>
      <RegistryTabs
        tabs={DEDUCTION_TABS}
        active={tab}
        onChange={setTab}
        tabId={tabId}
        panelId={panelId}
        label="Разделы удержаний"
      />

      <div {...panelProps('month')}>
        <RegistryPanel
          label="Удержания за месяц"
          columns={DEDUCTION_MONTH_COLUMNS}
          rows={monthRows}
          isLoading={staff.isLoading || plannedByMonth.isLoading}
          isError={staff.isError || plannedByMonth.isError}
          onRetry={() => { void staff.refetch(); void plannedByMonth.refetch(); }}
          rowKey={monthRowKey}
          rowLabel={rowName}
          searchText={rowName}
          fioSearch
          buildExport={buildDeductionMonthExport}
          sendExport={api.exportMonth}
          months={months}
          toolbarAction={toolbarAction}
          onAdd={canEdit ? () => setEditor({ mode: 'add-staff' }) : undefined}
          onEdit={canEdit ? editMonthRow : undefined}
          onDelete={canEdit ? deleteMonthRow : undefined}
          canEditRow={canEditMonthRow}
          busyKey={busyKey}
          groupRows={EMPLOYEE_ROW_GROUP}
          raisedFilters={raised}
          onFilterOpenChange={setFilterOpen}
        />
      </div>

      <div {...panelProps('planned')}>
        <RegistryPanel
          label="Плановые удержания"
          columns={PLANNED_DEDUCTION_COLUMNS}
          rows={planned.data}
          isLoading={planned.isLoading}
          isError={planned.isError}
          onRetry={() => { void planned.refetch(); }}
          rowKey={plannedRowKey}
          rowLabel={rowName}
          searchText={rowName}
          fioSearch
          buildExport={buildPlannedDeductionExport}
          sendExport={api.exportPlanned}
          months={months}
          toolbarAction={toolbarAction}
          onAdd={canEdit ? () => setEditor({ mode: 'add-planned' }) : undefined}
          onEdit={canEdit ? row => setEditor({ mode: 'planned', row }) : undefined}
          onDelete={canEdit ? row => { void removePlanned(row, plannedRowKey(row)); } : undefined}
          deleteLabel="Убрать"
          canEditRow={canEditPlannedRow}
          busyKey={busyKey}
          raisedFilters={raised}
          onFilterOpenChange={setFilterOpen}
        />
      </div>

      {(editor?.mode === 'add-staff' || editor?.mode === 'staff') && (
        <StaffDeductionModal
          deduction={editor.mode === 'staff' ? editor.row : undefined}
          kinds={kinds}
          api={api.staffEditor}
          raised={raised}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
      {(editor?.mode === 'add-planned' || editor?.mode === 'planned') && (
        <PlannedDeductionForm
          deduction={editor.mode === 'planned' ? editor.row : undefined}
          kinds={kinds}
          api={api.plannedEditor}
          raised={raised}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </>
  );
};
