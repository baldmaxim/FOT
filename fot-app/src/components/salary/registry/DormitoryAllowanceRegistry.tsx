import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IDormitoryAllowanceRow,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import {
  buildDormitoryAllowanceExport,
  DORMITORY_ALLOWANCE_COLUMNS,
  dormitoryAllowanceInMonths,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { RegistryPeriodForm } from './RegistryPeriodForm';

interface IDormitoryAllowanceRegistryProps {
  /** Право правки «Справочника» (/salary/terms или /salary/payments). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IDormitoryAllowanceRow } | null;

const sendExport = payrollRegistryService.exportTable('dormitory-allowances');
const rowKey = (row: IDormitoryAllowanceRow): number => row.id;
const rowName = (row: IDormitoryAllowanceRow): string => row.full_name;
const canEditRow = (row: IDormitoryAllowanceRow): boolean => row.can_edit;

/**
 * «Справочник» → «Ставки» → «Общежитие»: кому платят за то, что не живёт в общежитии компании, период «с — по»
 * (все периоды — история; показываются задевающие выбранные месяцы, кроме месяцев проживания в общежитии).
 * Сумма — значение ставки «Доплата за общежитие», одна на всех. Прекратили — ✎ и дата «по»; 🗑 — только ошибочная строка.
 */
export const DormitoryAllowanceRegistry: FC<IDormitoryAllowanceRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const months = useRegistryMonths();

  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.dormitoryAllowances,
    queryFn: ({ signal }) => payrollRegistryService.listDormitoryAllowances(signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => query.data?.filter(row => dormitoryAllowanceInMonths(row, months.value)),
    [query.data, months.value],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_REGISTRY_KEYS.dormitoryAllowances });

  const handleDelete = async (row: IDormitoryAllowanceRow) => {
    if (busyKey !== null) return;
    if (!window.confirm(`Удалить ошибочную строку: ${row.full_name}, с ${formatDate(row.date_from)}?`)) return;
    setBusyKey(row.id);
    try {
      await payrollRegistryService.removeDormitoryAllowance(row.id);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Доплата за общежитие" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Доплата за общежитие"
        columns={DORMITORY_ALLOWANCE_COLUMNS}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildDormitoryAllowanceExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void handleDelete(row); } : undefined}
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <RegistryPeriodForm
          title="Доплата за общежитие"
          fromLabel="Доплата с"
          row={editor.mode === 'edit' ? editor.row : undefined}
          onAdd={payrollRegistryService.addDormitoryAllowance}
          onUpdate={payrollRegistryService.updateDormitoryAllowance}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
