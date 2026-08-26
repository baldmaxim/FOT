import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../contexts/ToastContext';
import {
  leaveRequestService,
  type ILeaveRequest,
  type ILeaveRequestBulkResult,
} from '../services/leaveRequestService';
import { getLeaveRequestsManageQueryKey } from './usePortalData';
import type { CheckboxSelectionState } from '../components/ui/TriStateCheckbox';

/**
 * Сводка массового решения человеческим текстом. Считаем ВСЕ категории пропуска:
 * «закрытый табель» — самая частая причина, её нельзя терять в общем числе.
 */
export const formatBulkSummary = (
  verb: 'Согласовано' | 'Отклонено',
  data: ILeaveRequestBulkResult,
): string => {
  const skipped = data.skipped_not_pending + data.skipped_no_access
    + data.skipped_locked + data.skipped_failed;
  if (skipped === 0) return `${verb}: ${data.processed_count}`;
  const reasons: string[] = [];
  if (data.skipped_locked > 0) reasons.push(`закрыт табель: ${data.skipped_locked}`);
  if (data.skipped_no_access > 0) reasons.push(`нет доступа: ${data.skipped_no_access}`);
  if (data.skipped_not_pending > 0) reasons.push(`уже обработаны: ${data.skipped_not_pending}`);
  if (data.skipped_failed > 0) reasons.push(`с ошибкой: ${data.skipped_failed}`);
  return `${verb}: ${data.processed_count}, пропущено: ${skipped} (${reasons.join(', ')})`;
};

interface IUseLeaveRequestBulkActionsArgs {
  scope: 'department' | 'all';
  /** id заявлений, которые реально можно выбрать (видимые и в статусе pending). */
  selectableIds: number[];
}

export const useLeaveRequestBulkActions = ({ scope, selectableIds }: IUseLeaveRequestBulkActionsArgs) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  // Сырое множество отмеченных: в нём могут оставаться id, которых уже нет в списке
  // (сменились фильтры/вкладка, пришёл refetch).
  const [rawSelected, setRawSelected] = useState<Set<number>>(new Set());
  const [comment, setComment] = useState('');

  // selectableKey — стабильный слепок списка (сам массив пересоздаётся каждый рендер).
  const selectableKey = selectableIds.join(',');
  /**
   * Действующий выбор — пересечение с тем, что реально можно выбрать сейчас.
   * Считаем на рендере, а не синхронизируем эффектом: иначе один кадр выбор
   * содержал бы заявления, которых в списке уже нет (placeholderData вкладки «Все»).
   */
  const selectedIds = useMemo(() => {
    if (rawSelected.size === 0) return rawSelected;
    const allowed = new Set(selectableIds);
    return new Set([...rawSelected].filter(id => allowed.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSelected, selectableKey]);

  const toggleId = useCallback((id: number) => {
    setRawSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleMany = useCallback((ids: number[], checked: boolean) => {
    setRawSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback((checked: boolean) => {
    setRawSelected(checked ? new Set(selectableIds) : new Set());
  }, [selectableIds]);

  const clearSelection = useCallback(() => setRawSelected(new Set()), []);

  const selectionStateOf = useCallback((ids: number[]): CheckboxSelectionState => {
    if (ids.length === 0) return 'none';
    let count = 0;
    for (const id of ids) if (selectedIds.has(id)) count++;
    if (count === 0) return 'none';
    return count === ids.length ? 'all' : 'partial';
  }, [selectedIds]);

  const allSelectionState = useMemo(
    () => selectionStateOf(selectableIds),
    [selectionStateOf, selectableIds],
  );

  const applyResult = useCallback(async (verb: 'Согласовано' | 'Отклонено', data: ILeaveRequestBulkResult) => {
    // Из списка «Ожидающие» обработанные уходят сразу; на вкладке «Все» они должны
    // остаться с новым статусом, поэтому её только инвалидируем.
    if (data.processed_ids.length > 0) {
      const processed = new Set(data.processed_ids);
      queryClient.setQueryData<ILeaveRequest[] | undefined>(
        getLeaveRequestsManageQueryKey(scope, 'pending'),
        (prev) => (prev ? prev.filter(r => !processed.has(r.id)) : prev),
      );
      setRawSelected(prev => {
        const next = new Set([...prev].filter(id => !processed.has(id)));
        return next.size === prev.size ? prev : next;
      });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
      queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
      queryClient.invalidateQueries({ queryKey: ['correction-approvals'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
    ]);
    const message = formatBulkSummary(verb, data);
    if (data.processed_count === 0) toast.error(message);
    else toast.success(message);
    if (data.processed_count > 0) setComment('');
  }, [queryClient, scope, toast]);

  const approveMutation = useMutation({
    mutationFn: (ids: number[]) => leaveRequestService.bulkApprove(ids, comment.trim() || undefined),
    onSuccess: (data) => applyResult('Согласовано', data),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Ошибка массового согласования'),
  });

  const rejectMutation = useMutation({
    mutationFn: (ids: number[]) => leaveRequestService.bulkReject(ids, comment.trim() || undefined),
    onSuccess: (data) => applyResult('Отклонено', data),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Ошибка массового отклонения'),
  });

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    allSelectionState,
    selectionStateOf,
    toggleId,
    toggleMany,
    toggleAll,
    clearSelection,
    comment,
    setComment,
    bulkPending: approveMutation.isPending || rejectMutation.isPending,
    // Защита API от пустого пакета (кнопки при пустом выборе и так disabled).
    approveSelected: () => { if (selectedIds.size > 0) approveMutation.mutate([...selectedIds]); },
    rejectSelected: () => { if (selectedIds.size > 0) rejectMutation.mutate([...selectedIds]); },
  };
};
