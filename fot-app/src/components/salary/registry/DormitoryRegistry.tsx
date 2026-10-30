import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  DORMITORY_ADDRESSES_KEY,
  DORMITORY_STAYS_KEY,
  dormitoryService,
  PAYROLL_DORMITORY_STAYS_KEY,
  type IPayrollDormitoryStay,
} from '../../../services/dormitoryService';
import { PAYROLL_TERMS_PREFIX, payrollRegistryService } from '../../../services/payrollRegistryService';
import { dormitoryAddressOptions } from '../../../utils/dormitoryStayForm';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildDormitoryRegistryExport,
  buildDormitoryRegistryRows,
  DORMITORY_REGISTRY_COLUMNS,
  stayRemovalMode,
  type IDormitoryRegistryRow,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DormitoryStayModal, type IDormitoryStayModalPayroll } from '../../staff/dormitory/DormitoryStayModal';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { StayCheckoutModal } from './StayCheckoutModal';

interface IDormitoryRegistryProps {
  /** Право правки «Справочника» (/salary/terms или /salary/payments). */
  canEdit: boolean;
  onClose: () => void;
}

const sendExport = payrollRegistryService.exportTable('dormitory-stays');
const rowKey = (row: IDormitoryRegistryRow): string => row.key;
const rowName = (row: IDormitoryRegistryRow): string => row.full_name;
const canEditRow = (row: IDormitoryRegistryRow): boolean => row.stay.can_edit;

/** Заселение из «Зарплаты»: поиск «штата зарплаты» (без тех, кого править нельзя) и запись общежития. */
const PAYROLL_STAY: IDormitoryStayModalPayroll = {
  search: async (term, signal) => (await payrollRegistryService.searchEmployees(term, signal))
    .filter(candidate => candidate.can_edit)
    .map(({ id, full_name, department, position }) => ({ id, full_name: full_name ?? '', department, position })),
  add: dormitoryService.addForPayroll,
};

/**
 * «Справочник» → «Общежитие» (кнопка в шапке): кто живёт в общежитии компании, задевая выбранные месяцы, — те же
 * записи, что у кадров «Проживание». Живущие не получают доплату за общежитие: её расчёт ставит всем членам бригад
 * сам, кроме дней в общежитии и в квартире (миграция 339). «Добавить сотрудника» — заселить (общежитие, въезд,
 * выезд); 🗑 «Убрать» — окно «Дата выезда» (по умолчанию сегодня); не начавшееся или прошедшее проживание удаляется
 * как ошибочное. Уволенных не видно, их записи остаются.
 */
export const DormitoryRegistry: FC<IDormitoryRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [checkout, setCheckout] = useState<IPayrollDormitoryStay | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const months = useRegistryMonths();

  const staysQuery = useQuery({
    queryKey: PAYROLL_DORMITORY_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.listForPayroll(signal),
    staleTime: 0,
  });
  // Подсказки адресов — только окну заселения.
  const addressesQuery = useQuery({
    queryKey: [...DORMITORY_ADDRESSES_KEY, 'payroll'],
    queryFn: ({ signal }) => dormitoryService.listAddressesForPayroll(signal),
    enabled: adding,
  });
  const rows = useMemo(
    () => (staysQuery.data ? buildDormitoryRegistryRows(staysQuery.data, months.value) : undefined),
    [staysQuery.data, months.value],
  );
  const addresses = useMemo(() => dormitoryAddressOptions(addressesQuery.data ?? []), [addressesQuery.data]);

  // 'dormitory-stays' — проживающих здесь и во вкладке кадров «Проживание»; 'payroll-terms' — расчёт и листок.
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY }),
  ]);

  const handleDelete = async (row: IDormitoryRegistryRow) => {
    if (busyKey !== null) return;
    const { stay } = row;
    if (stayRemovalMode(stay, moscowTodayIso()) === 'checkout') {
      setCheckout(stay);
      return;
    }
    if (!window.confirm(`Удалить ошибочную строку: ${stay.full_name}, въезд ${formatDate(stay.check_in)}?`)) return;
    setBusyKey(row.key);
    try {
      await dormitoryService.removeForPayroll(stay.id);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  const handleCheckout = async (checkOut: string) => {
    if (!checkout) return;
    try {
      await dormitoryService.closeForPayroll(checkout.id, checkOut);
    } finally {
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Общежитие" onClose={onClose} closeOnEscape={!filterOpen && !adding && !checkout}>
      <RegistryPanel
        label="Общежитие"
        columns={DORMITORY_REGISTRY_COLUMNS}
        rows={rows}
        isLoading={staysQuery.isLoading}
        isError={staysQuery.isError}
        onRetry={() => { void staysQuery.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildDormitoryRegistryExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setAdding(true) : undefined}
        onDelete={canEdit ? row => { void handleDelete(row); } : undefined}
        deleteLabel="Убрать"
        canDeleteRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {adding && (
        <DormitoryStayModal
          addresses={addresses}
          payroll={PAYROLL_STAY}
          onClose={() => setAdding(false)}
          onSaved={() => { void refresh(); }}
        />
      )}

      {checkout && (
        <StayCheckoutModal stay={checkout} onClose={() => setCheckout(null)} onSubmit={handleCheckout} />
      )}
    </PayrollRegistryModal>
  );
};
