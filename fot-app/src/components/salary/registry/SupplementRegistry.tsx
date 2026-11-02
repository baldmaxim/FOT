import { useId, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { usePayrollRates } from '../../../hooks/usePayrollRates';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { HOUSING_RATE_CODE } from '../../../services/payrollService';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IHousingAllowanceRow,
  type IPayrollSupplementRow,
} from '../../../services/payrollRegistryService';
import {
  buildHousingExport,
  buildPlannedSupplementExport,
  buildSupplementExport,
  buildSupplementRegistryRows,
  canEditSupplement,
  canEditSupplementRow,
  EMPLOYEE_ROW_GROUP,
  HOUSING_COLUMNS,
  housingRowKey,
  PLANNED_SUPPLEMENT_COLUMNS,
  SUPPLEMENT_COLUMNS,
  supplementInMonths,
  supplementRowKey,
  type ISupplementRegistryRow,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { HousingAllowanceForm } from './HousingAllowanceForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { SupplementForm } from './SupplementForm';
import { SupplementTabs, type SupplementTab } from './SupplementTabs';
import { StayCheckoutModal } from './StayCheckoutModal';
import { useSupplementRemoval } from './useSupplementRemoval';
import styles from './SupplementTabs.module.css';

interface ISupplementRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  onClose: () => void;
}

/** Вид операции, а не вкладка: из «Все доплаты» правятся строки всех видов. */
type EditorState =
  | { mode: 'add-one-time' }
  | { mode: 'add-planned' }
  | { mode: 'add-housing' }
  | { mode: 'supplement'; row: IPayrollSupplementRow }
  | { mode: 'housing'; row: IHousingAllowanceRow }
  | null;

const sendSupplementExport = payrollRegistryService.exportTable('supplements');
const sendHousingExport = payrollRegistryService.exportTable('housing');
const rowKey = (row: ISupplementRegistryRow): string => row.key;
const rowName = (row: { full_name: string }): string => row.full_name;
const canEditHousing = (row: IHousingAllowanceRow): boolean => row.can_edit;

/**
 * «Справочник» → «Доплата», вкладки одного окна; месяц общий, поиск и фильтры столбцов у каждой свои.
 * «Все доплаты» — все доплаты выбранных месяцев: плановые (их период задевает месяц), разовые за месяц и квартиры
 * «Проживания» («Плановая» с основанием «Квартира»); кнопка добавления — разовая (за месяц — сколько угодно, у каждой
 * основание). ФИО, отдел и должность — один раз, доплаты сотрудника (плановые, квартира, разовые) — строками под ним.
 * «Плановые доплаты» — кому назначена плановая (та же, что в окне сотрудника) и на какой период; ✎ и 🗑 — у любого
 * периода (миграция 337). «Квартира» — те же записи, что во вкладке кадров «Проживание» (миграция 320): ставка за день
 * (миграция 339), в окне сотрудника «Компенсация → Проживание» — только показ. ✎ и 🗑 у строки — те же окна и правила
 * на всех вкладках (useSupplementRemoval).
 */
export const SupplementRegistry: FC<ISupplementRegistryProps> = ({ canEdit, onClose }) => {
  const tabsId = useId();
  const [tab, setTab] = useState<SupplementTab>('all');
  const months = useRegistryMonths();
  const rates = usePayrollRates();
  const {
    busyKey, removeSupplement, removeHousing, refreshSupplements, refreshHousing,
    housingCheckout, closeHousingCheckout, checkoutHousing,
  } = useSupplementRemoval();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const tabId = (key: SupplementTab) => `${tabsId}-tab-${key}`;
  const panelId = (key: SupplementTab) => `${tabsId}-panel-${key}`;

  // Приходят все доплаты: разовые — за свой месяц, плановая — если её период задевает выбранные месяцы.
  const supplements = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.supplements,
    queryFn: ({ signal }) => payrollRegistryService.listSupplements(signal),
    staleTime: 0,
  });
  // Квартиры сервер отбирает по месяцам сам.
  const housing = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.housing, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listHousing(months.param, signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => buildSupplementRegistryRows(supplements.data, housing.data, months.value),
    [supplements.data, housing.data, months.value],
  );
  const plannedRows = useMemo(
    () => supplements.data?.filter(row => row.kind === 'planned' && supplementInMonths(row, months.value)),
    [supplements.data, months.value],
  );
  const defaultAmount = rates.data?.find(rate => rate.code === HOUSING_RATE_CODE)?.amount ?? null;

  const handleEdit = (row: ISupplementRegistryRow) => {
    if (row.supplement) setEditor({ mode: 'supplement', row: row.supplement });
    else if (row.housing) setEditor({ mode: 'housing', row: row.housing });
  };
  const handleDelete = (row: ISupplementRegistryRow) => {
    if (row.supplement) void removeSupplement(row.supplement);
    else if (row.housing) void removeHousing(row.housing);
  };
  const tabPanelProps = (key: SupplementTab) => ({
    className: styles.tabPanel,
    role: 'tabpanel',
    id: panelId(key),
    'aria-labelledby': tabId(key),
    hidden: tab !== key,
    // Таблица прокручивается внутри окна, шапка закреплена (RegistryTable.module.css).
    'data-registry-fill': true,
  });

  return (
    <PayrollRegistryModal
      title="Доплата"
      onClose={onClose}
      closeOnEscape={!filterOpen && !editor && !housingCheckout}
    >
      <SupplementTabs active={tab} onChange={setTab} tabId={tabId} panelId={panelId} />

      <div {...tabPanelProps('all')}>
        <RegistryPanel
          label="Доплата"
          columns={SUPPLEMENT_COLUMNS}
          rows={rows}
          isLoading={supplements.isLoading || housing.isLoading}
          isError={supplements.isError || housing.isError}
          onRetry={() => { void supplements.refetch(); void housing.refetch(); }}
          rowKey={rowKey}
          rowLabel={rowName}
          searchText={rowName}
          fioSearch
          buildExport={buildSupplementExport}
          sendExport={sendSupplementExport}
          months={months}
          onAdd={canEdit ? () => setEditor({ mode: 'add-one-time' }) : undefined}
          addLabel="Разовая доплата"
          onEdit={canEdit ? handleEdit : undefined}
          onDelete={canEdit ? handleDelete : undefined}
          deleteLabel="Убрать"
          canEditRow={canEditSupplementRow}
          busyKey={busyKey}
          groupRows={EMPLOYEE_ROW_GROUP}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
        />
      </div>

      <div {...tabPanelProps('planned')}>
        <RegistryPanel
          label="Плановые доплаты"
          columns={PLANNED_SUPPLEMENT_COLUMNS}
          rows={plannedRows}
          isLoading={supplements.isLoading}
          isError={supplements.isError}
          onRetry={() => { void supplements.refetch(); }}
          rowKey={supplementRowKey}
          rowLabel={rowName}
          searchText={rowName}
          fioSearch
          buildExport={buildPlannedSupplementExport}
          sendExport={sendSupplementExport}
          months={months}
          onAdd={canEdit ? () => setEditor({ mode: 'add-planned' }) : undefined}
          onEdit={canEdit ? row => setEditor({ mode: 'supplement', row }) : undefined}
          onDelete={canEdit ? row => { void removeSupplement(row); } : undefined}
          deleteLabel="Убрать"
          canEditRow={canEditSupplement}
          busyKey={busyKey}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
        />
      </div>

      <div {...tabPanelProps('apartments')}>
        <RegistryPanel
          label="Квартира"
          columns={HOUSING_COLUMNS}
          rows={housing.data}
          isLoading={housing.isLoading}
          isError={housing.isError}
          onRetry={() => { void housing.refetch(); }}
          rowKey={housingRowKey}
          rowLabel={rowName}
          searchText={rowName}
          fioSearch
          buildExport={buildHousingExport}
          sendExport={sendHousingExport}
          months={months}
          onAdd={canEdit ? () => setEditor({ mode: 'add-housing' }) : undefined}
          onEdit={canEdit ? row => setEditor({ mode: 'housing', row }) : undefined}
          onDelete={canEdit ? row => { void removeHousing(row); } : undefined}
          deleteLabel="Убрать"
          canEditRow={canEditHousing}
          busyKey={busyKey}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
        />
      </div>

      {editor?.mode === 'housing' || editor?.mode === 'add-housing' ? (
        <HousingAllowanceForm
          row={editor.mode === 'housing' ? editor.row : undefined}
          defaultAmount={defaultAmount}
          onClose={() => setEditor(null)}
          onSaved={() => { void refreshHousing(); }}
        />
      ) : editor && (
        <SupplementForm
          kind={editor.mode === 'add-planned' ? 'planned' : 'one_time'}
          row={editor.mode === 'supplement' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refreshSupplements(); }}
        />
      )}

      {housingCheckout && (
        <StayCheckoutModal stay={housingCheckout} onClose={closeHousingCheckout} onSubmit={checkoutHousing} />
      )}
    </PayrollRegistryModal>
  );
};
