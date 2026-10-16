import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { DORMITORY_STAYS_KEY, dormitoryService, type IDormitoryStay } from '../../../services/dormitoryService';
import { formatDate } from '../../../utils/formatMoney';
import { DormitoryStayModal } from './DormitoryStayModal';
import { DormitoryStaysPanel } from './DormitoryStaysPanel';

/** Окно правки: добавление или ✎ конкретного проживания. */
type EditorState = { mode: 'add' } | { mode: 'edit'; stay: IDormitoryStay } | null;

/**
 * «Управление кадрами» → «Общежитие» (миграция 314): кто живёт в общежитии — все проживания, текущие
 * и прошлые. С правом «Редактирование» — «Добавить сотрудника», ✎ и 🗑; «Экспорт» — ровно таблица экрана.
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

  // Префикс общий с таблицей «Справочника» «Зарплаты» — она тоже перечитается.
  const refresh = () => queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY });

  const handleDelete = async (stay: IDormitoryStay) => {
    if (deletingId !== null) return;
    if (!window.confirm(`Удалить проживание: ${stay.full_name}, въезд ${formatDate(stay.check_in)}?`)) return;
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
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </>
  );
};
