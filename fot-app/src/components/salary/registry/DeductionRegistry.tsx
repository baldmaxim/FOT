import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IDeductionRegistryRow,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { buildDeductionExport, DEDUCTION_COLUMNS } from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DeductionForm } from './DeductionForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';

interface IDeductionRegistryProps {
  /** Право правки условий оплаты (/salary/terms): сумма удержания — часть условий. */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IDeductionRegistryRow } | null;

const sendExport = payrollRegistryService.exportTable('deductions');
const rowKey = (row: IDeductionRegistryRow): number => row.employee_id;
const rowName = (row: IDeductionRegistryRow): string => row.full_name;
const canEditRow = (row: IDeductionRegistryRow): boolean => row.can_edit;

/**
 * «Справочник» → «Удержания»: у кого есть вид удержания или сумма удержания в условиях выбранных месяцев
 * (сумма — из последней версии условий в них; виды датой не хранятся — текущий набор). Те же данные, что
 * «Удержание» окна сотрудника: правка здесь видна там, и наоборот. Сумма меняется с даты «Действует с».
 */
export const DeductionRegistry: FC<IDeductionRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const months = useRegistryMonths();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);

  const query = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.deductions, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listDeductions(months.param, signal),
    staleTime: 0,
  });

  // Условия оплаты поменялись — перечитать и список «Расчётов», и открытое окно сотрудника.
  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });

  const handleRemove = async (row: IDeductionRegistryRow) => {
    if (busyKey !== null) return;
    if (!window.confirm(`Снять удержания у ${row.full_name} с сегодняшнего дня?`)) return;
    setBusyKey(row.employee_id);
    try {
      await payrollRegistryService.saveDeduction(row.employee_id, { kind_ids: [], amount: null, effective_from: moscowTodayIso() });
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось снять удержания');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Удержания" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Удержания"
        columns={DEDUCTION_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildDeductionExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void handleRemove(row); } : undefined}
        deleteLabel="Снять"
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <DeductionForm
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
