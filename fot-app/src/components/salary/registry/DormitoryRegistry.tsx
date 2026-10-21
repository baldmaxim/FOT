import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { dormitoryService, PAYROLL_DORMITORY_STAYS_KEY } from '../../../services/dormitoryService';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IDormitoryAllowanceRow,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildDormitoryRegistryExport,
  buildDormitoryRegistryRows,
  DORMITORY_REGISTRY_COLUMNS,
  registryRemoval,
  type IDormitoryRegistryRow,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { RegistryPeriodForm } from './RegistryPeriodForm';

interface IDormitoryRegistryProps {
  /** Право правки «Справочника» (/salary/terms или /salary/payments). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IDormitoryAllowanceRow } | null;

const sendExport = payrollRegistryService.exportTable('dormitory-allowances');
const rowKey = (row: IDormitoryRegistryRow): string => row.key;
const rowName = (row: IDormitoryRegistryRow): string => row.full_name;
// Проживание ведут кадры («Управление кадрами» → «Проживание»): здесь правится только доплата.
const canEditRow = (row: IDormitoryRegistryRow): boolean => row.allowance?.can_edit ?? false;

/**
 * «Справочник» → «Общежитие» (кнопка в шапке): одна таблица — кто живёт в общежитии компании (адрес, въезд —
 * выезд; только просмотр) и кому общежитие не назначено — «Доплата за общежитие», период «с — по» (все периоды —
 * история; в месяцах проживания строки доплаты нет). Сумма доплаты — значение ставки, одна на всех.
 * «Добавить сотрудника», ✎ и 🗑 — только доплата. 🗑 «Убрать» — с 1-го числа текущего месяца: период закрывается
 * датой «по», прошлые месяцы остаются; не начавшийся или прошлый период — ошибочная строка, удаляется.
 */
export const DormitoryRegistry: FC<IDormitoryRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const months = useRegistryMonths();

  const staysQuery = useQuery({
    queryKey: PAYROLL_DORMITORY_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.listForPayroll(signal),
    staleTime: 0,
  });
  const allowancesQuery = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.dormitoryAllowances,
    queryFn: ({ signal }) => payrollRegistryService.listDormitoryAllowances(signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => (staysQuery.data && allowancesQuery.data
      ? buildDormitoryRegistryRows(staysQuery.data, allowancesQuery.data, months.value)
      : undefined),
    [staysQuery.data, allowancesQuery.data, months.value],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_REGISTRY_KEYS.dormitoryAllowances });

  const handleDelete = async (row: IDormitoryRegistryRow) => {
    const allowance = row.allowance;
    if (!allowance || busyKey !== null) return;
    // Убран с 1-го числа: прошлые месяцы остаются историей; не начавшийся или прошлый период — ошибочный.
    const removal = registryRemoval(allowance, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать ${allowance.full_name} из «Доплата за общежитие» с ${formatDate(removal.cutoff)}? По ${formatDate(removal.dateTo)} строка останется в истории.`
      : `Удалить ошибочную строку: ${allowance.full_name}, с ${formatDate(allowance.date_from)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(row.key);
    try {
      if (removal.action === 'close') {
        await payrollRegistryService.updateDormitoryAllowance(allowance.id, { date_from: allowance.date_from, date_to: removal.dateTo });
      } else {
        await payrollRegistryService.removeDormitoryAllowance(allowance.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Общежитие" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Общежитие"
        columns={DORMITORY_REGISTRY_COLUMNS}
        rows={rows}
        isLoading={staysQuery.isLoading || allowancesQuery.isLoading}
        isError={staysQuery.isError || allowancesQuery.isError}
        onRetry={() => {
          void staysQuery.refetch();
          void allowancesQuery.refetch();
        }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildDormitoryRegistryExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => { if (row.allowance) setEditor({ mode: 'edit', row: row.allowance }); } : undefined}
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
