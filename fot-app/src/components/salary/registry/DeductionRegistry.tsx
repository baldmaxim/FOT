import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { usePayrollDeductionKinds } from '../../../hooks/usePayrollDeductionKinds';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IDeductionRegistryRow,
} from '../../../services/payrollRegistryService';
import { invalidateDeductionQueries } from '../../../utils/deductionQueries';
import { formatMonthLabel } from '../../../utils/formatMoney';
import {
  buildStaffDeductionExport,
  STAFF_DEDUCTION_COLUMNS,
  staffDeductionKindLabel,
} from '../../../utils/staffDeductionTable';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { StaffDeductionModal, type IStaffDeductionEditorApi } from '../../staff/deductions/StaffDeductionModal';
import { PayrollRegistryModal } from './PayrollRegistryModal';

interface IDeductionRegistryProps {
  /** Право правки условий оплаты (/salary/terms) — как у прочих таблиц сотрудников «Справочника». */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; row: IDeductionRegistryRow } | null;

const sendExport = payrollRegistryService.exportTable('deductions');
const rowKey = (row: IDeductionRegistryRow): number => row.id;
const rowName = (row: IDeductionRegistryRow): string => row.full_name;
const canEditRow = (row: IDeductionRegistryRow): boolean => row.can_edit;

/** Окно удержания в «Зарплате»: поиск — «штат зарплаты», запись — через API «Зарплаты». */
const PAYROLL_EDITOR_API: IStaffDeductionEditorApi = {
  searchEmployees: payrollRegistryService.searchEmployees,
  add: payrollRegistryService.addDeduction,
  update: payrollRegistryService.updateDeduction,
};

/**
 * «Справочник» → «Удержания» → «Сотрудники»: удержания (вид, подвид, месяц, сумма) выбранных месяцев — те же записи,
 * что во вкладке кадров «Удержания» (миграция 321): добавленное или удалённое здесь видно там, и наоборот. Охват —
 * «штат зарплаты»: прошлые строки уволенных правят кадры. В окне сотрудника — тот же список, только показ.
 */
export const DeductionRegistry: FC<IDeductionRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const months = useRegistryMonths();
  const kinds = usePayrollDeductionKinds();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);

  const query = useQuery({
    queryKey: [...PAYROLL_REGISTRY_KEYS.deductions, months.param],
    queryFn: ({ signal }) => payrollRegistryService.listDeductions(months.param, signal),
    staleTime: 0,
  });

  // Записи общие с кадрами: перечитать и вкладку кадров, и окно сотрудника.
  const refresh = () => invalidateDeductionQueries(queryClient);

  const handleRemove = async (row: IDeductionRegistryRow) => {
    if (busyKey !== null) return;
    const question = `Удалить удержание: ${row.full_name}, ${staffDeductionKindLabel(row)}, ${formatMonthLabel(row.month)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(row.id);
    try {
      await payrollRegistryService.removeDeduction(row.id);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Удержания" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Удержания"
        columns={STAFF_DEDUCTION_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildStaffDeductionExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', row }) : undefined}
        onDelete={canEdit ? row => { void handleRemove(row); } : undefined}
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <StaffDeductionModal
          deduction={editor.mode === 'edit' ? editor.row : undefined}
          kinds={kinds.data ?? []}
          api={PAYROLL_EDITOR_API}
          raised
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
