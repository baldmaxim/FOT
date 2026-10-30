import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IPayrollSupplementRow,
} from '../../../services/payrollRegistryService';
import {
  buildPlannedSupplementExport,
  canEditSupplement,
  PLANNED_SUPPLEMENT_COLUMNS,
  supplementInMonths,
  supplementRowKey,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { SupplementForm } from './SupplementForm';
import { useSupplementRemoval } from './useSupplementRemoval';

interface IPlannedSupplementRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  /** Месяцы общей таблицы «Доплата» — список открывается на них. */
  initialMonths: ReadonlyArray<string>;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IPayrollSupplementRow } | null;

const sendExport = payrollRegistryService.exportTable('supplements');
const rowName = (row: IPayrollSupplementRow): string => row.full_name;

/**
 * «Справочник» → «Доплата» → «Плановые доплаты»: кому назначена плановая (та же, что в окне сотрудника) и на какой
 * период; строки — периоды, задевающие выбранные месяцы. Назначенный попадает в общую таблицу «Доплата» в месяцах
 * периода. ✎ и 🗑 — у любого периода (миграция 337). 🗑 — убрать с 1-го числа текущего месяца (прошлые месяцы
 * остаются); не начавшийся или прошедший период снимается как ошибочный.
 */
export const PlannedSupplementRegistry: FC<IPlannedSupplementRegistryProps> = ({ canEdit, initialMonths, onClose }) => {
  const months = useRegistryMonths(initialMonths);
  const { busyKey, removeSupplement, refreshSupplements } = useSupplementRemoval();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);

  // Тот же запрос, что у общей таблицы «Доплата»: приходят все доплаты, здесь — только плановые.
  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.supplements,
    queryFn: ({ signal }) => payrollRegistryService.listSupplements(signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => query.data?.filter(row => row.kind === 'planned' && supplementInMonths(row, months.value)),
    [query.data, months.value],
  );

  return (
    <PayrollRegistryModal
      title="Плановые доплаты"
      backLabel="Назад к доплате"
      onClose={onClose}
      closeOnEscape={!filterOpen && !editor}
    >
      <RegistryPanel
        label="Плановые доплаты"
        columns={PLANNED_SUPPLEMENT_COLUMNS}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={supplementRowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildPlannedSupplementExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void removeSupplement(row); } : undefined}
        deleteLabel="Убрать"
        canEditRow={canEditSupplement}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <SupplementForm
          kind="planned"
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refreshSupplements(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
