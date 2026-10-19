import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { usePayrollRates } from '../../../hooks/usePayrollRates';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { HOUSING_RATE_CODE } from '../../../services/payrollService';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IHousingAllowanceRow,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { buildHousingExport, HOUSING_COLUMNS } from '../../../utils/payrollRegistries';
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
const rowKey = (row: IHousingAllowanceRow): number => row.employee_id;
const rowName = (row: IHousingAllowanceRow): string => row.full_name;
const canEditRow = (row: IHousingAllowanceRow): boolean => row.can_edit;

/**
 * «Справочник» → «Ставки» → «Доплата за проживание»: у кого в условиях оплаты выбранных месяцев есть доплата
 * за проживание (последняя версия условий в них). Те же данные, что «Компенсация → Проживание» окна сотрудника: правка здесь видна там, и наоборот.
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

  // Условия оплаты поменялись — перечитать и список «Расчётов», и открытое окно сотрудника.
  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });

  const handleRemove = async (row: IHousingAllowanceRow) => {
    if (busyKey !== null) return;
    if (!window.confirm(`Снять доплату за проживание у ${row.full_name} с сегодняшнего дня?`)) return;
    setBusyKey(row.employee_id);
    try {
      await payrollRegistryService.setHousing(row.employee_id, { amount: null, effective_from: moscowTodayIso() });
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось снять доплату');
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
        buildExport={buildHousingExport}
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
