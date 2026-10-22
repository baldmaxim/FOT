import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { usePayrollRates } from '../../../hooks/usePayrollRates';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  DORMITORY_STAYS_KEY,
  dormitoryService,
  PAYROLL_DORMITORY_STAYS_KEY,
  type IPayrollDormitoryStay,
} from '../../../services/dormitoryService';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IDormitoryAllowanceRow,
} from '../../../services/payrollRegistryService';
import { DORMITORY_ALLOWANCE_RATE_CODE } from '../../../services/payrollService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildDormitoryRegistryExport,
  buildDormitoryRegistryRows,
  DORMITORY_REGISTRY_COLUMNS,
  registryRemoval,
  stayRemoval,
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
// Проживание ведут кадры («Управление кадрами» → «Проживание»): здесь правится только доплата, проживание — только 🗑.
const canEditRow = (row: IDormitoryRegistryRow): boolean => row.allowance?.can_edit ?? false;
const canDeleteRow = (row: IDormitoryRegistryRow): boolean => row.allowance?.can_edit ?? row.stay?.can_edit ?? false;

/**
 * «Справочник» → «Общежитие» (кнопка в шапке): одна таблица — кто живёт в общежитии компании (адрес, въезд —
 * выезд) и кому общежитие не назначено — «Доплата за общежитие», период «с — по» (все периоды — история; в месяцах
 * проживания строки доплаты нет). Уволенных не видно, их записи остаются. Сумма доплаты — ставка за последний
 * выбранный месяц, в который доплата положена (миграция 324: смена ставки прошлые месяцы не трогает), одна на всех.
 * «Добавить сотрудника» и ✎ — только доплата; 🗑 «Убрать» — и доплата, и проживание: с 1-го числа текущего месяца
 * (период закрывается, у проживания — выездом 1-го числа), прошлые месяцы остаются; не начавшийся или прошлый
 * период — ошибочная строка, удаляется.
 */
export const DormitoryRegistry: FC<IDormitoryRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const months = useRegistryMonths();
  const rates = usePayrollRates();
  // Нет истории (старый бэкенд, ставки не загрузились) — сумма строки от сервера.
  const allowanceRateValues = rates.data?.find(rate => rate.code === DORMITORY_ALLOWANCE_RATE_CODE)?.values;

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
      ? buildDormitoryRegistryRows(staysQuery.data, allowancesQuery.data, months.value, allowanceRateValues)
      : undefined),
    [staysQuery.data, allowancesQuery.data, months.value, allowanceRateValues],
  );

  // Доплата за общежитие — в листке «Истории выплат»: префикс 'payroll-terms' перечитывает и его, и доплаты;
  // 'dormitory-stays' — проживающих здесь и во вкладке кадров «Проживание».
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY }),
  ]);

  const handleStayDelete = async (row: IDormitoryRegistryRow, stay: IPayrollDormitoryStay) => {
    // Выезд 1-м числом: прошлые месяцы остаются историей; не начавшееся или прошедшее проживание — ошибочное.
    const removal = stayRemoval(stay, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать ${stay.full_name} из общежития с ${formatDate(removal.checkOut)}? Прошлые месяцы останутся в истории.`
      : `Удалить ошибочную строку: ${stay.full_name}, въезд ${formatDate(stay.check_in)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(row.key);
    try {
      if (removal.action === 'close') {
        await dormitoryService.closeForPayroll(stay.id, removal.checkOut);
      } else {
        await dormitoryService.removeForPayroll(stay.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  const handleDelete = async (row: IDormitoryRegistryRow) => {
    if (busyKey !== null) return;
    if (row.stay) {
      await handleStayDelete(row, row.stay);
      return;
    }
    const allowance = row.allowance;
    if (!allowance) return;
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
        fioSearch
        buildExport={buildDormitoryRegistryExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => { if (row.allowance) setEditor({ mode: 'edit', row: row.allowance }); } : undefined}
        onDelete={canEdit ? row => { void handleDelete(row); } : undefined}
        deleteLabel="Убрать"
        canEditRow={canEditRow}
        canDeleteRow={canDeleteRow}
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
