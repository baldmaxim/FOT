import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { usePayrollRates } from '../../../hooks/usePayrollRates';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { HOUSING_RATE_CODE } from '../../../services/payrollService';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IHousingAllowanceRow,
} from '../../../services/payrollRegistryService';
import { buildHousingExport, HOUSING_COLUMNS, housingRowKey } from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { HousingAllowanceForm } from './HousingAllowanceForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { useSupplementRemoval } from './useSupplementRemoval';

interface IHousingAllowanceRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  /** Месяцы общей таблицы «Доплата» — список открывается на них. */
  initialMonths: ReadonlyArray<string>;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IHousingAllowanceRow } | null;

const sendExport = payrollRegistryService.exportTable('housing');
const rowName = (row: IHousingAllowanceRow): string => row.full_name;
const canEditRow = (row: IHousingAllowanceRow): boolean => row.can_edit;

/**
 * «Справочник» → «Доплата» → «Квартира»: квартиры «Проживания» (миграция 320), задевающие выбранные месяцы, —
 * те же записи, что во вкладке кадров «Проживание»: правка здесь видна там, и наоборот. В общей таблице «Доплата»
 * квартира — строкой «Плановая» с основанием «Квартира»; в окне сотрудника «Компенсация → Проживание» — сумма на
 * дату (только показ). 🗑 «Убрать» — выезд 1-м числом текущего месяца (прошлые месяцы остаются); не начавшееся
 * или прошедшее проживание удаляется как ошибочное.
 */
export const HousingAllowanceRegistry: FC<IHousingAllowanceRegistryProps> = ({ canEdit, initialMonths, onClose }) => {
  const rates = usePayrollRates();
  const months = useRegistryMonths(initialMonths);
  const { busyKey, removeHousing, refreshHousing } = useSupplementRemoval();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);

  const query = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.housing, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listHousing(months.param, signal),
    staleTime: 0,
  });
  const defaultAmount = rates.data?.find(rate => rate.code === HOUSING_RATE_CODE)?.amount ?? null;

  return (
    <PayrollRegistryModal
      title="Квартира"
      backLabel="Назад к доплате"
      onClose={onClose}
      closeOnEscape={!filterOpen && !editor}
    >
      <RegistryPanel
        label="Квартира"
        columns={HOUSING_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={housingRowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildHousingExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void removeHousing(row); } : undefined}
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
          onSaved={() => { void refreshHousing(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
