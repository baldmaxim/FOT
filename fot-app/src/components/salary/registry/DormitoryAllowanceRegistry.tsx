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
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildDormitoryAllowanceExport,
  DORMITORY_ALLOWANCE_COLUMNS,
  dormitoryAllowanceInMonths,
  registryRemoval,
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
 * Сумма — значение ставки «Доплата за общежитие», одна на всех. 🗑 «Убрать» — с 1-го числа текущего месяца: период
 * закрывается датой «по», прошлые месяцы остаются; не начавшийся или прошлый период — ошибочная строка, удаляется.
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
    // Убран с 1-го числа: прошлые месяцы остаются историей; не начавшийся или прошлый период — ошибочный.
    const removal = registryRemoval(row, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать ${row.full_name} из «Доплата за общежитие» с ${formatDate(removal.cutoff)}? По ${formatDate(removal.dateTo)} строка останется в истории.`
      : `Удалить ошибочную строку: ${row.full_name}, с ${formatDate(row.date_from)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(row.id);
    try {
      if (removal.action === 'close') {
        await payrollRegistryService.updateDormitoryAllowance(row.id, { date_from: row.date_from, date_to: removal.dateTo });
      } else {
        await payrollRegistryService.removeDormitoryAllowance(row.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
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
        deleteLabel="Убрать"
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
