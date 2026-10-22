import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';

import { ApiError } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import { useStaffDeductionKinds } from '../../../hooks/useStaffDeductionKinds';
import {
  STAFF_DEDUCTIONS_KEY,
  staffDeductionService,
  type IStaffDeduction,
} from '../../../services/staffDeductionService';
import { invalidateDeductionQueries } from '../../../utils/deductionQueries';
import { formatMonthLabel } from '../../../utils/formatMoney';
import {
  buildStaffDeductionExport,
  STAFF_DEDUCTION_COLUMNS,
  staffDeductionInMonths,
  staffDeductionKindLabel,
} from '../../../utils/staffDeductionTable';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DeductionKindsModal } from './DeductionKindsModal';
import { StaffDeductionModal, type IStaffDeductionEditorApi } from './StaffDeductionModal';

/** Окно правки: добавление или ✎ конкретного удержания. */
type EditorState = { mode: 'add' } | { mode: 'edit'; deduction: IStaffDeduction } | null;

const deductionKey = (deduction: IStaffDeduction): number => deduction.id;
const deductionName = (deduction: IStaffDeduction): string => deduction.full_name;

/** Окно удержания у кадров: поиск и запись — через API кадров (право /staff-control/deductions). */
const STAFF_EDITOR_API: IStaffDeductionEditorApi = {
  searchEmployees: staffDeductionService.searchEmployees,
  add: staffDeductionService.add,
  update: staffDeductionService.update,
};

/**
 * «Управление кадрами» → «Удержания» (миграции 318, 321): удержания сотрудников — вид, подвид, месяц, сумма — за
 * выбранные месяцы. Те же записи — в «Зарплате» («Справочник» → «Удержания» → «Сотрудники»). С правом
 * «Редактирование» — «Добавить сотрудника», ✎ и 🗑; «Виды удержаний» — справочник с подвидами, общий с «Зарплатой»;
 * «Экспорт» — ровно таблица экрана.
 */
export const DeductionsTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/deductions');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(null);
  const [kindsOpen, setKindsOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const months = useRegistryMonths();
  const kinds = useStaffDeductionKinds();

  const deductionsQuery = useQuery({
    queryKey: STAFF_DEDUCTIONS_KEY,
    queryFn: ({ signal }) => staffDeductionService.list(signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => deductionsQuery.data?.filter(row => staffDeductionInMonths(row, months.value)),
    [deductionsQuery.data, months.value],
  );

  // Записи общие с «Зарплатой»: перечитать и её таблицу, и окно сотрудника.
  const refresh = () => invalidateDeductionQueries(queryClient);

  const handleDelete = async (deduction: IStaffDeduction) => {
    if (deletingId !== null) return;
    const question = `Удалить удержание: ${deduction.full_name}, ${staffDeductionKindLabel(deduction)}, ${formatMonthLabel(deduction.month)}?`;
    if (!window.confirm(question)) return;
    setDeletingId(deduction.id);
    try {
      await staffDeductionService.remove(deduction.id);
      queryClient.setQueryData<IStaffDeduction[]>(STAFF_DEDUCTIONS_KEY, list => list?.filter(item => item.id !== deduction.id));
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setDeletingId(null);
      void refresh();
    }
  };

  return (
    <>
      <RegistryPanel
        label="Удержания"
        columns={STAFF_DEDUCTION_COLUMNS}
        rows={rows}
        isLoading={deductionsQuery.isLoading}
        isError={deductionsQuery.isError}
        onRetry={() => { void deductionsQuery.refetch(); }}
        rowKey={deductionKey}
        rowLabel={deductionName}
        searchText={deductionName}
        fioSearch
        buildExport={buildStaffDeductionExport}
        sendExport={staffDeductionService.exportTable}
        months={months}
        toolbarAction={{ label: 'Виды удержаний', icon: ListChecks, onClick: () => setKindsOpen(true) }}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? deduction => setEditor({ mode: 'edit', deduction }) : undefined}
        onDelete={canEdit ? deduction => { void handleDelete(deduction); } : undefined}
        busyKey={deletingId}
      />

      {editor && (
        <StaffDeductionModal
          deduction={editor.mode === 'edit' ? editor.deduction : undefined}
          kinds={kinds.data ?? []}
          api={STAFF_EDITOR_API}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}

      {kindsOpen && <DeductionKindsModal canEdit={canEdit} onClose={() => setKindsOpen(false)} />}
    </>
  );
};
