import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IPayrollSupplementRow,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildSupplementExport,
  registryRemoval,
  type RegistryRemoval,
  SUPPLEMENT_COLUMNS,
  supplementInMonths,
  supplementPeriod,
  supplementRowKey,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { SupplementForm } from './SupplementForm';

interface ISupplementRegistryProps {
  /** Право правки условий оплаты (/salary/terms). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IPayrollSupplementRow } | null;

const sendExport = payrollRegistryService.exportTable('supplements');
const rowName = (row: IPayrollSupplementRow): string => row.full_name;
// Прошлый период плановой — история: эндпоинты меняют только текущую версию.
const canEditRow = (row: IPayrollSupplementRow): boolean => row.can_edit && row.is_current !== false;

/** 🗑 у плановой: убрать с 1-го числа (период закрывается) или снять ошибочную; у разовой — удалить. */
const plannedRemoval = (row: IPayrollSupplementRow): RegistryRemoval | null => (
  row.kind === 'planned' && row.date_from !== null
    ? registryRemoval({ date_from: row.date_from, date_to: row.date_to }, moscowTodayIso())
    : null
);

/**
 * «Справочник» → «Доплата»: плановые (текущая — та же, что в окне сотрудника, и прошлые периоды) и разовые
 * доплаты выбранных месяцев. Ввод — здесь: текущая плановая одна на сотрудника, разовых за месяц — сколько угодно,
 * у каждой основание. 🗑 у плановой — «убрать» с 1-го числа текущего месяца: период закрывается, прошлые месяцы
 * остаются; не начавшаяся или прошлая — снимается как ошибочная.
 */
export const SupplementRegistry: FC<ISupplementRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const months = useRegistryMonths();

  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.supplements,
    queryFn: ({ signal }) => payrollRegistryService.listSupplements(signal),
    staleTime: 0,
  });
  // Приходят все доплаты: разовые — за свой месяц, плановая — если её период задевает выбранные месяцы.
  const rows = useMemo(
    () => query.data?.filter(row => supplementInMonths(row, months.value)),
    [query.data, months.value],
  );

  // Плановая — та же, что в окне сотрудника: перечитать и список «Расчётов», и окно.
  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });

  const handleDelete = async (row: IPayrollSupplementRow) => {
    if (busyKey !== null) return;
    const removal = plannedRemoval(row);
    let question: string;
    if (removal?.action === 'close') {
      question = `Убрать плановую доплату у ${row.full_name} с ${formatDate(removal.cutoff)}? `
        + `Период ${formatDate(row.date_from)} – ${formatDate(removal.dateTo)} останется в истории.`;
    } else if (row.kind === 'planned') {
      question = `Снять плановую доплату у ${row.full_name} (${supplementPeriod(row)})?`;
    } else {
      question = `Удалить разовую доплату у ${row.full_name} за ${supplementPeriod(row)}?`;
    }
    if (!window.confirm(question)) return;
    const key = supplementRowKey(row);
    setBusyKey(key);
    try {
      if (removal?.action === 'close' && row.date_from !== null) {
        await payrollRegistryService.setPlanned(row.employee_id, {
          amount: Number(row.amount),
          date_from: row.date_from,
          date_to: removal.dateTo,
        });
      } else if (row.kind === 'planned') {
        await payrollRegistryService.removePlanned(row.employee_id);
      } else if (row.id !== null) {
        await payrollRegistryService.removeOneTime(row.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Доплата" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Доплата"
        columns={SUPPLEMENT_COLUMNS}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={supplementRowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildSupplementExport}
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
        <SupplementForm
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
