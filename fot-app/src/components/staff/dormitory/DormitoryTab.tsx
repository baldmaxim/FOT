import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import {
  DORMITORY_ADDRESSES_KEY,
  DORMITORY_STAYS_KEY,
  dormitoryService,
  type IDormitoryStay,
} from '../../../services/dormitoryService';
import { PAYROLL_TERMS_PREFIX } from '../../../services/payrollRegistryService';
import {
  DORMITORY_PRESET_ADDRESSES,
  DORMITORY_STAY_KIND_LABELS,
  dormitoryAddressOptions,
} from '../../../utils/dormitoryStayForm';
import { formatDate } from '../../../utils/formatMoney';
import { DormitoryStayModal } from './DormitoryStayModal';
import { DormitoryStaysPanel } from './DormitoryStaysPanel';

/** Окно правки: добавление или ✎ конкретного проживания. */
type EditorState = { mode: 'add' } | { mode: 'edit'; stay: IDormitoryStay } | null;

/**
 * «Управление кадрами» → «Проживание» (миграции 314, 320): где живут сотрудники — общежитие или квартира, все
 * проживания, текущие и прошлые. Квартиры — те же записи, что «Доплата за проживание» «Зарплаты». С правом
 * «Редактирование» — «Добавить сотрудника», ✎ и 🗑; «Экспорт» — ровно таблица экрана.
 */
export const DormitoryTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/dormitory');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const staysQuery = useQuery({
    queryKey: DORMITORY_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.list(signal),
    staleTime: 0,
  });
  // Подсказки «Адрес / номер»: 9 общежитий и все когда-либо сохранённые адреса — нужны только окну правки.
  const addressesQuery = useQuery({
    queryKey: DORMITORY_ADDRESSES_KEY,
    queryFn: ({ signal }) => dormitoryService.listAddresses(signal),
    enabled: canEdit,
    staleTime: 0,
  });
  const addresses = useMemo(
    () => dormitoryAddressOptions([...DORMITORY_PRESET_ADDRESSES, ...(addressesQuery.data ?? [])]),
    [addressesQuery.data],
  );

  // Префикс общий с таблицей «Справочника» «Зарплаты» и подсказками адресов — они тоже перечитаются; квартиры —
  // «Доплата за проживание» и «Компенсация проживания» условий оплаты (префикс 'payroll-terms').
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY }),
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
  ]);

  const handleDelete = async (stay: IDormitoryStay) => {
    if (deletingId !== null) return;
    const where = DORMITORY_STAY_KIND_LABELS[stay.kind].toLowerCase();
    if (!window.confirm(`Удалить проживание (${where}): ${stay.full_name}, въезд ${formatDate(stay.check_in)}?`)) return;
    setDeletingId(stay.id);
    try {
      await dormitoryService.remove(stay.id);
      queryClient.setQueryData<IDormitoryStay[]>(DORMITORY_STAYS_KEY, list => list?.filter(item => item.id !== stay.id));
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setDeletingId(null);
      void refresh();
    }
  };

  return (
    <>
      <DormitoryStaysPanel
        rows={staysQuery.data}
        isLoading={staysQuery.isLoading}
        isError={staysQuery.isError}
        onRetry={() => { void staysQuery.refetch(); }}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? stay => setEditor({ mode: 'edit', stay }) : undefined}
        onDelete={canEdit ? stay => { void handleDelete(stay); } : undefined}
        busyId={deletingId}
      />

      {editor && (
        <DormitoryStayModal
          stay={editor.mode === 'edit' ? editor.stay : undefined}
          addresses={addresses}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </>
  );
};
