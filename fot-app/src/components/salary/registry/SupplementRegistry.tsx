import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IHousingAllowanceRow,
  type IPayrollSupplementRow,
} from '../../../services/payrollRegistryService';
import {
  buildSupplementExport,
  buildSupplementRegistryRows,
  canEditSupplementRow,
  SUPPLEMENT_COLUMNS,
  type ISupplementRegistryRow,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { HousingAllowanceForm } from './HousingAllowanceForm';
import { HousingAllowanceRegistry } from './HousingAllowanceRegistry';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { PlannedSupplementRegistry } from './PlannedSupplementRegistry';
import { SupplementForm } from './SupplementForm';
import { SupplementListsBar } from './SupplementListsBar';
import { StayCheckoutModal } from './StayCheckoutModal';
import { useSupplementRemoval } from './useSupplementRemoval';

interface ISupplementRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState =
  | { mode: 'add' }
  | { mode: 'supplement'; row: IPayrollSupplementRow }
  | { mode: 'housing'; row: IHousingAllowanceRow }
  | null;

/** Список назначений, открытый поверх «Доплаты». */
type OpenedList = 'planned' | 'apartments';

const sendExport = payrollRegistryService.exportTable('supplements');
const rowKey = (row: ISupplementRegistryRow): string => row.key;
const rowName = (row: ISupplementRegistryRow): string => row.full_name;

/**
 * «Справочник» → «Доплата»: все доплаты выбранных месяцев — плановые (их период задевает месяц), разовые за месяц
 * и квартиры «Проживания» («Плановая» с основанием «Квартира»). Назначения ведутся в списках справа от поиска:
 * «Плановые доплаты» и «Квартира»; «Добавить сотрудника» здесь — разовая (за месяц — сколько угодно, у каждой
 * основание). ✎ и 🗑 у строки — те же окна и правила, что в списках.
 */
export const SupplementRegistry: FC<ISupplementRegistryProps> = ({ canEdit, onClose }) => {
  const months = useRegistryMonths();
  const {
    busyKey, removeSupplement, removeHousing, refreshSupplements, refreshHousing,
    housingCheckout, closeHousingCheckout, checkoutHousing,
  } = useSupplementRemoval();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [openedList, setOpenedList] = useState<OpenedList | null>(null);

  // Приходят все доплаты: разовые — за свой месяц, плановая — если её период задевает выбранные месяцы.
  const supplements = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.supplements,
    queryFn: ({ signal }) => payrollRegistryService.listSupplements(signal),
    staleTime: 0,
  });
  // Квартиры сервер отбирает по месяцам сам.
  const housing = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.housing, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listHousing(months.param, signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => buildSupplementRegistryRows(supplements.data, housing.data, months.value),
    [supplements.data, housing.data, months.value],
  );

  const handleEdit = (row: ISupplementRegistryRow) => {
    if (row.supplement) setEditor({ mode: 'supplement', row: row.supplement });
    else if (row.housing) setEditor({ mode: 'housing', row: row.housing });
  };
  const handleDelete = (row: ISupplementRegistryRow) => {
    if (row.supplement) void removeSupplement(row.supplement);
    else if (row.housing) void removeHousing(row.housing);
  };

  return (
    <PayrollRegistryModal
      title="Доплата"
      onClose={onClose}
      closeOnEscape={!filterOpen && !editor && openedList === null && !housingCheckout}
    >
      <RegistryPanel
        label="Доплата"
        columns={SUPPLEMENT_COLUMNS}
        rows={rows}
        isLoading={supplements.isLoading || housing.isLoading}
        isError={supplements.isError || housing.isError}
        onRetry={() => { void supplements.refetch(); void housing.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        searchAside={() => (
          <SupplementListsBar
            onOpenPlanned={() => setOpenedList('planned')}
            onOpenApartments={() => setOpenedList('apartments')}
          />
        )}
        buildExport={buildSupplementExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        addLabel="Разовая доплата"
        onEdit={canEdit ? handleEdit : undefined}
        onDelete={canEdit ? handleDelete : undefined}
        deleteLabel="Убрать"
        canEditRow={canEditSupplementRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor?.mode === 'housing' ? (
        <HousingAllowanceForm
          row={editor.row}
          defaultAmount={null}
          onClose={() => setEditor(null)}
          onSaved={() => { void refreshHousing(); }}
        />
      ) : editor && (
        <SupplementForm
          kind="one_time"
          row={editor.mode === 'supplement' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refreshSupplements(); }}
        />
      )}

      {housingCheckout && (
        <StayCheckoutModal stay={housingCheckout} onClose={closeHousingCheckout} onSubmit={checkoutHousing} />
      )}

      {openedList === 'planned' && (
        <PlannedSupplementRegistry canEdit={canEdit} initialMonths={months.value} onClose={() => setOpenedList(null)} />
      )}
      {openedList === 'apartments' && (
        <HousingAllowanceRegistry canEdit={canEdit} initialMonths={months.value} onClose={() => setOpenedList(null)} />
      )}
    </PayrollRegistryModal>
  );
};
