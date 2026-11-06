import type { Dispatch, SetStateAction } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import type { IObjectModalTarget } from '../../../pages/timesheet/timesheetPage.helpers';
import { correctionAttachmentsService } from '../../../services/correctionAttachmentsService';
import { timesheetService } from '../../../services/timesheetService';
import type { TimesheetEmployee, TimesheetEntry, TimesheetObjectEntry, TimesheetStatus } from '../../../types';
import type { TimesheetResponse } from '../../../types/timesheet';

/** Запись из окна дня вкладки «Выходные»: те же запросы и порядок, что в TimesheetPage. */

const MODAL_WRITE_BLOCKED_MESSAGE = 'Данные дня обновляются — повторите через секунду';
export const OBJECT_ENTRIES_DISABLED_MESSAGE = 'Корректировки по объектам недоступны для вашей роли. Используйте режим «По сотрудникам».';

export interface IObjectPrompt {
  candidates: Array<{ object_id: string; object_name: string }>;
  pending: { status: TimesheetStatus; hours: number | null; notes: string; files?: File[] };
  selected: string;
}

interface IWeekendCorrectionWritesArgs {
  modalEmployee: TimesheetEmployee | null;
  modalEntry: TimesheetEntry | null;
  modalMode: 'day' | 'object';
  modalObjectEntry: TimesheetObjectEntry | null;
  modalObjectTarget: IObjectModalTarget | null;
  modalWorkDate: string;
  objectPrompt: IObjectPrompt | null;
  objectEntriesDisabled: boolean;
  queryKey: QueryKey;
  setModalEntry: Dispatch<SetStateAction<TimesheetEntry | null>>;
  setModalMode: Dispatch<SetStateAction<'day' | 'object'>>;
  setModalObjectEntry: Dispatch<SetStateAction<TimesheetObjectEntry | null>>;
  setModalObjectTarget: Dispatch<SetStateAction<IObjectModalTarget | null>>;
  setObjectPrompt: Dispatch<SetStateAction<IObjectPrompt | null>>;
  closeModal: () => void;
  isModalWriteBlocked: () => boolean;
}

export const useWeekendCorrectionWrites = ({
  modalEmployee, modalEntry, modalMode, modalObjectEntry, modalObjectTarget, modalWorkDate, objectPrompt,
  objectEntriesDisabled, queryKey, setModalEntry, setModalMode, setModalObjectEntry, setModalObjectTarget,
  setObjectPrompt, closeModal, isModalWriteBlocked,
}: IWeekendCorrectionWritesArgs) => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const invalidateCaches = async (employeeId?: number | null) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-salary'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-employee-objects'] }),
      ...(employeeId ? [queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', employeeId] })] : []),
    ]);
  };

  const invalidateLeaveRequests = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
    queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
  ]);

  const uploadFiles = async (adjustmentId: number, files: File[] | undefined, failedMessage: string) => {
    if (!files || files.length === 0) return;
    try {
      await Promise.all(files.map(file => correctionAttachmentsService.upload(adjustmentId, file)));
    } catch (uploadErr) {
      console.error('Upload correction files error:', uploadErr);
      toast.error(uploadErr instanceof Error ? uploadErr.message : failedMessage);
    }
    queryClient.invalidateQueries({ queryKey: ['correction-attachments', adjustmentId] });
  };

  const handleSaveCorrection = async (
    status: TimesheetStatus,
    hours: number | null,
    notes: string,
    files?: File[],
    allocations?: Array<{ object_id: string; hours: number }> | null,
  ) => {
    if (!modalEmployee || isModalWriteBlocked()) return;
    try {
      if (modalEntry?.id) {
        await timesheetService.update(modalEntry.id, {
          status,
          hours_worked: hours,
          notes,
          // Отсутствие поля = «не трогать распределение»; пустой массив снимает его.
          ...(allocations ? { object_allocations: allocations } : {}),
        });
        closeModal();
      } else {
        const created = await timesheetService.create({
          employee_id: modalEmployee.id,
          work_date: modalWorkDate,
          status,
          hours_worked: hours,
          notes,
          ...(allocations && allocations.length > 0 ? { object_allocations: allocations } : {}),
        });
        if (created.id != null) await uploadFiles(created.id, files, 'Корректировка создана, но файлы не загрузились');
        // После добавления окно остаётся: файл цепляется к id, который есть только теперь.
        setModalMode('day');
        setModalObjectEntry(null);
        setModalObjectTarget(null);
        setModalEntry(created);
      }
      await invalidateCaches(modalEmployee.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OBJECT_REQUIRED') {
        const candidates = Array.isArray((err.details as { candidates?: unknown })?.candidates)
          ? ((err.details as { candidates: IObjectPrompt['candidates'] }).candidates)
          : [];
        setObjectPrompt({ candidates, pending: { status, hours, notes, files }, selected: candidates[0]?.object_id ?? '' });
        return;
      }
      console.error('Save correction error:', err);
      toast.error(err instanceof Error ? err.message : 'Не удалось сохранить корректировку');
    }
  };

  // Отдельная «Удалёнка» поверх согласованного выхода в выходной: всегда create, а не правка заявки.
  const handleAddRemoteOverWork = async (hours: number, notes: string, files?: File[]) => {
    if (!modalEmployee || isModalWriteBlocked()) return;
    try {
      const created = await timesheetService.create({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        status: 'remote',
        hours_worked: hours,
        notes,
      });
      if (created.id != null) await uploadFiles(created.id, files, 'Удалёнка добавлена, но файлы не загрузились');
      await invalidateCaches(modalEmployee.id);
      // Свежая запись с companion_work_request: в ответе create() её ещё нет.
      const fresh = queryClient.getQueryData<TimesheetResponse>(queryKey);
      const freshEntry = fresh?.entries?.find(
        item => item.employee_id === modalEmployee.id && item.work_date === modalWorkDate,
      ) ?? null;
      if (freshEntry) {
        setModalMode('day');
        setModalObjectEntry(null);
        setModalObjectTarget(null);
        setModalEntry(freshEntry);
      }
    } catch (err) {
      console.error('Add remote over work error:', err);
      toast.error(err instanceof Error ? err.message : 'Не удалось добавить удалёнку');
    }
  };

  // Повторное сохранение с явно выбранным объектом (после OBJECT_REQUIRED).
  const confirmObjectPrompt = async () => {
    if (!objectPrompt || !modalEmployee || !objectPrompt.selected || isModalWriteBlocked()) return;
    const { pending, selected } = objectPrompt;
    try {
      const created = await timesheetService.create({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        status: pending.status,
        hours_worked: pending.hours,
        notes: pending.notes,
        object_id: selected,
      });
      if (created.id != null) await uploadFiles(created.id, pending.files, 'Корректировка создана, но файлы не загрузились');
      setObjectPrompt(null);
      closeModal();
      await invalidateCaches(modalEmployee.id);
    } catch (err) {
      console.error('Save correction with object error:', err);
      toast.error(err instanceof Error ? err.message : 'Не удалось сохранить корректировку');
    }
  };

  const handleSaveObjectCorrection = async (_status: TimesheetStatus, hours: number | null, notes: string, files?: File[]) => {
    if (!modalEmployee || !modalObjectTarget || hours == null || isModalWriteBlocked()) return;
    try {
      const saved = await timesheetService.upsertObjectEntry({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        object_key: modalObjectTarget.object_key,
        object_id: modalObjectTarget.object_id,
        object_name: modalObjectTarget.object_name,
        hours_worked: hours,
        notes,
      });
      if (saved.adjustment_id != null) await uploadFiles(saved.adjustment_id, files, 'Корректировка создана, но файлы не загрузились');
      closeModal();
      await invalidateCaches(modalEmployee.id);
    } catch (error) {
      console.error('Save object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить корректировку по объекту');
    }
  };

  const handleSaveModalCorrection = (
    status: TimesheetStatus,
    hours: number | null,
    notes: string,
    files?: File[],
    allocations?: Array<{ object_id: string; hours: number }> | null,
  ) => {
    // Дневная форма с распределением сохраняется дневным путём, даже открытая со строки объекта.
    if (allocations && allocations.length > 0) return handleSaveCorrection(status, hours, notes, files, allocations);
    if (modalMode === 'object' && (status === 'work' || status === 'manual')) {
      return handleSaveObjectCorrection(status, hours, notes, files);
    }
    return handleSaveCorrection(status, hours, notes, files);
  };

  const handleDeleteDayCorrection = async () => {
    if (!modalEntry?.id || !modalEmployee || isModalWriteBlocked()) return;
    try {
      await timesheetService.delete(modalEntry.id);
      closeModal();
      await Promise.all([invalidateCaches(modalEmployee.id), invalidateLeaveRequests()]);
    } catch (error) {
      console.error('Delete day correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку');
    }
  };

  // Правка текста заявки не закрывает окно. Вызывающий ждёт промис: при блокировке — ошибка.
  const handleUpdateReason = async (id: number, reason: string) => {
    if (isModalWriteBlocked()) throw new Error(MODAL_WRITE_BLOCKED_MESSAGE);
    try {
      await timesheetService.update(id, { notes: reason });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить текст заявления');
      throw error;
    }
    setModalEntry((prev) => {
      if (!prev) return prev;
      if (prev.id === id) return { ...prev, notes: reason };
      if (prev.companion_work_request?.id === id) {
        return { ...prev, companion_work_request: { ...prev.companion_work_request, reason } };
      }
      return prev;
    });
    await Promise.all([invalidateCaches(), invalidateLeaveRequests()]);
  };

  const handleDeleteObjectCorrection = async () => {
    if (objectEntriesDisabled) {
      toast.error(OBJECT_ENTRIES_DISABLED_MESSAGE);
      return;
    }
    if (!modalEmployee || !modalObjectTarget || !modalObjectEntry?.adjustment_id || isModalWriteBlocked()) return;
    try {
      // «Эхо» корректировки на весь день: объектной строки за ним нет, снимаем саму дневную запись.
      if (modalObjectEntry.from_day_level) {
        await timesheetService.delete(modalObjectEntry.adjustment_id);
        closeModal();
        await Promise.all([invalidateCaches(modalEmployee.id), invalidateLeaveRequests()]);
        return;
      }
      await timesheetService.deleteObjectEntry({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        object_key: modalObjectTarget.object_key,
      });
      closeModal();
      await invalidateCaches(modalEmployee.id);
    } catch (error) {
      console.error('Delete object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку по объекту');
    }
  };

  const handleSaveObjectByTarget = async (
    target: { object_key: string; object_id: string | null; object_name: string },
    hours: number,
    notes: string,
  ) => {
    if (objectEntriesDisabled) {
      toast.error(OBJECT_ENTRIES_DISABLED_MESSAGE);
      return;
    }
    if (!modalEmployee || isModalWriteBlocked()) return;
    try {
      await timesheetService.upsertObjectEntry({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        object_key: target.object_key,
        object_id: target.object_id,
        object_name: target.object_name,
        hours_worked: hours,
        notes,
      });
      closeModal();
      await invalidateCaches(modalEmployee.id);
    } catch (error) {
      console.error('Save object correction (by target) error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить корректировку по объекту');
    }
  };

  const handleDeleteObjectByTarget = async (
    target: { object_key: string; object_id: string | null; object_name: string },
  ) => {
    if (objectEntriesDisabled) {
      toast.error(OBJECT_ENTRIES_DISABLED_MESSAGE);
      return;
    }
    if (!modalEmployee || isModalWriteBlocked()) return;
    try {
      await timesheetService.deleteObjectEntry({
        employee_id: modalEmployee.id,
        work_date: modalWorkDate,
        object_key: target.object_key,
      });
      closeModal();
      await invalidateCaches(modalEmployee.id);
    } catch (error) {
      console.error('Delete object correction (by target) error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку по объекту');
    }
  };

  return {
    confirmObjectPrompt,
    handleSaveCorrection,
    handleSaveModalCorrection,
    handleAddRemoteOverWork,
    handleDeleteDayCorrection,
    handleDeleteObjectCorrection,
    handleUpdateReason,
    handleSaveObjectByTarget,
    handleDeleteObjectByTarget,
  };
};
