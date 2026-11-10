import { useCallback, useId, useMemo, useState, type FC, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';

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
  supplementFileCount,
  supplementInMonths,
  supplementRowKey,
  type ISupplementRegistryRow,
} from '../../../utils/payrollRegistries';
import { FilePreviewModal } from '../../documents/FilePreviewModal';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { RegistryTabs, type IRegistryTab } from '../../ui/registry/RegistryTabs';
import { HousingAllowanceForm } from './HousingAllowanceForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { SupplementFilesModal } from './SupplementFilesModal';
import { SupplementForm } from './SupplementForm';
import { StayCheckoutModal } from './StayCheckoutModal';
import { useSupplementFileOpen } from './useSupplementFileOpen';
import { useSupplementRemoval } from './useSupplementRemoval';
import fileStyles from './SupplementFiles.module.css';
import styles from '../../ui/registry/RegistryTabs.module.css';

interface ISupplementRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  onClose: () => void;
}

type SupplementTab = 'all' | 'planned' | 'apartments';

const SUPPLEMENT_TABS: ReadonlyArray<IRegistryTab<SupplementTab>> = [
  { key: 'all', label: 'Доплата за месяц' },
  { key: 'planned', label: 'Плановые доплаты' },
  { key: 'apartments', label: 'Квартира' },
];

/** Вид операции, а не вкладка: из «Доплаты за месяц» правятся строки всех видов. */
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
 * «Доплата за месяц» — все доплаты выбранных месяцев: плановые (их период задевает месяц), разовые за месяц и квартиры
 * «Проживания» («Плановая» с основанием «Квартира», строка на месяц с суммой за месяц из расчёта ФОТ — как в
 * «Расчётах»); кнопка добавления — разовая (за месяц — сколько угодно, у каждой основание). ФИО, отдел и должность —
 * один раз, доплаты сотрудника (плановые, квартира, разовые) — строками под ним.
 * «Плановые доплаты» — кому назначена плановая (та же, что в окне сотрудника) и на какой период; ✎ и 🗑 — у любого
 * периода (миграция 337). «Квартира» — те же записи, что во вкладке кадров «Проживание» (миграция 320): ставка за день
 * (миграция 339), в окне сотрудника «Компенсация → Проживание» — только показ. ✎ и 🗑 у строки — те же окна и правила
 * на всех вкладках (useSupplementRemoval).
 * «Файлы» разовой (миграция 354): 📎N — один файл открывается сразу, несколько — окно списка; ссылка — по клику.
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
  const fileOpen = useSupplementFileOpen();
  const { open: openFile } = fileOpen;
  // Разовая с несколькими файлами — окно списка.
  const [filesRow, setFilesRow] = useState<IPayrollSupplementRow | null>(null);
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
  // «Доплата за месяц»: квартира в каждом месяце с суммой за месяц — сервер считает её расчётом ФОТ.
  const housingByMonth = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.housing, 'by-month', months.param],
    queryFn: ({ signal }) => payrollRegistryService.listHousingByMonth(months.param, signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => buildSupplementRegistryRows(supplements.data, housingByMonth.data, months.value),
    [supplements.data, housingByMonth.data, months.value],
  );
  const plannedRows = useMemo(
    () => supplements.data?.filter(row => row.kind === 'planned' && supplementInMonths(row, months.value)),
    [supplements.data, months.value],
  );
  const defaultAmount = rates.data?.find(rate => rate.code === HOUSING_RATE_CODE)?.amount ?? null;

  const openRowFiles = useCallback((row: IPayrollSupplementRow) => {
    const files = row.files ?? [];
    if (row.id === null || files.length === 0) return;
    if (files.length === 1) openFile(row.id, files[0]);
    else setFilesRow(row);
  }, [openFile]);
  // 📎N — у основания разовой с файлами (отдельному столбцу на 1280px места нет).
  const cellRenderers = useMemo(() => ({
    reason: (row: ISupplementRegistryRow): ReactNode | undefined => {
      const count = supplementFileCount(row);
      const { supplement } = row;
      if (count === null || !supplement) return undefined;
      return (
        <span className={fileStyles.reasonCell}>
          <span className={fileStyles.reasonText}>{row.reason ?? '—'}</span>
          <button
            type="button"
            className={fileStyles.cellButton}
            title="Файлы"
            aria-label={`Файлы: ${row.full_name}, ${count}`}
            onClick={() => openRowFiles(supplement)}
          >
            <Paperclip size={14} aria-hidden="true" />
            {count}
          </button>
        </span>
      );
    },
  }), [openRowFiles]);

  const handleEdit = (row: ISupplementRegistryRow) => {
    if (row.supplement) setEditor({ mode: 'supplement', row: row.supplement });
    else if (row.housing) setEditor({ mode: 'housing', row: row.housing });
  };
  const handleDelete = (row: ISupplementRegistryRow) => {
    if (row.supplement) void removeSupplement(row.supplement);
    else if (row.housing) void removeHousing(row.housing, row.key);
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
      closeOnEscape={!filterOpen && !editor && !housingCheckout && !filesRow && !fileOpen.preview}
    >
      <RegistryTabs
        tabs={SUPPLEMENT_TABS}
        active={tab}
        onChange={setTab}
        tabId={tabId}
        panelId={panelId}
        label="Разделы доплаты"
      />

      <div {...tabPanelProps('all')}>
        <RegistryPanel
          label="Доплата за месяц"
          columns={SUPPLEMENT_COLUMNS}
          rows={rows}
          isLoading={supplements.isLoading || housingByMonth.isLoading}
          isError={supplements.isError || housingByMonth.isError}
          onRetry={() => { void supplements.refetch(); void housingByMonth.refetch(); }}
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
          cellRenderers={cellRenderers}
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

      {filesRow && filesRow.id !== null && (
        <SupplementFilesModal
          fullName={filesRow.full_name}
          files={filesRow.files ?? []}
          onOpen={file => { if (filesRow.id !== null) openFile(filesRow.id, file); }}
          closeOnEscape={!fileOpen.preview}
          onClose={() => setFilesRow(null)}
        />
      )}

      {fileOpen.preview && (
        <FilePreviewModal
          fileName={fileOpen.preview.fileName}
          mimeType={fileOpen.preview.mimeType}
          urlLoader={fileOpen.preview.urlLoader}
          onClose={fileOpen.closePreview}
        />
      )}
    </PayrollRegistryModal>
  );
};
