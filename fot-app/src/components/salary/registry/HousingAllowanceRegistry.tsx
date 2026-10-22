import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { usePayrollRates } from '../../../hooks/usePayrollRates';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { DORMITORY_STAYS_KEY } from '../../../services/dormitoryService';
import { HOUSING_RATE_CODE } from '../../../services/payrollService';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IHousingAllowanceRow,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { buildHousingExport, HOUSING_COLUMNS, stayRemoval } from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { HousingAllowanceForm } from './HousingAllowanceForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';

interface IHousingAllowanceRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IHousingAllowanceRow } | null;

const sendExport = payrollRegistryService.exportTable('housing');
const rowKey = (row: IHousingAllowanceRow): number => row.id;
const rowName = (row: IHousingAllowanceRow): string => row.full_name;
const canEditRow = (row: IHousingAllowanceRow): boolean => row.can_edit;

/**
 * «Справочник» → «Ставки» → «Доплата за проживание»: квартиры «Проживания» (миграция 320), задевающие выбранные
 * месяцы, — те же записи, что во вкладке кадров «Проживание»: правка здесь видна там, и наоборот. В окне сотрудника
 * «Компенсация → Проживание» — сумма квартиры на дату (только показ). 🗑 «Убрать» — выезд 1-м числом текущего
 * месяца (прошлые месяцы остаются); не начавшееся или прошедшее проживание удаляется как ошибочное.
 */
export const HousingAllowanceRegistry: FC<IHousingAllowanceRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const rates = usePayrollRates();
  const months = useRegistryMonths();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);

  const query = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.housing, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listHousing(months.param, signal),
    staleTime: 0,
  });
  const defaultAmount = rates.data?.find(rate => rate.code === HOUSING_RATE_CODE)?.amount ?? null;

  // Квартира поменялась — перечитать список «Расчётов» с окном сотрудника и вкладку кадров «Проживание».
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY }),
  ]);

  const handleRemove = async (row: IHousingAllowanceRow) => {
    if (busyKey !== null) return;
    const removal = stayRemoval(row, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать доплату за проживание у ${row.full_name} с ${formatDate(removal.checkOut)}? Прошлые месяцы останутся в истории.`
      : `Удалить ошибочную строку: ${row.full_name}, въезд ${formatDate(row.check_in)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(row.id);
    try {
      if (removal.action === 'close') {
        await payrollRegistryService.updateHousing(row.id, {
          check_in: row.check_in, check_out: removal.checkOut, amount: Number(row.amount), address: row.address,
        });
      } else {
        await payrollRegistryService.removeHousing(row.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Доплата за проживание" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Доплата за проживание"
        columns={HOUSING_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildHousingExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void handleRemove(row); } : undefined}
        deleteLabel="Убрать"
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <HousingAllowanceForm
          row={editor.mode === 'edit' ? editor.row : undefined}
          defaultAmount={defaultAmount}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
