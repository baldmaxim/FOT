import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';

import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import type { IObjectModalTarget } from '../../../pages/timesheet/timesheetPage.helpers';
import { timesheetService } from '../../../services/timesheetService';
import type { TimesheetEmployee, TimesheetEntry, TimesheetObjectEntry } from '../../../types';
import type { TimesheetResponse } from '../../../types/timesheet';
import { selectVisibleHours, selectVisibleObjectHours } from '../../../utils/hoursDisplay';
import {
  getCorrectionDefaultHoursForDay,
  getCorrectionMaxHoursForDay,
  getScheduleForTimesheetDay,
} from '../../../utils/scheduleUtils';
import { weekendLockStatus } from '../../../utils/staffWeekendGrid';
import { COVERED_DAY_MESSAGE, isDayCoveredByDepartment, resolveReadOnlyReason } from '../../../utils/timesheetCoverage';
import { decideModalRefresh, pickModalDayData } from '../../../utils/timesheetModalRefresh';
import {
  OBJECT_ENTRIES_DISABLED_MESSAGE,
  useWeekendCorrectionWrites,
  type IObjectPrompt,
} from './useWeekendCorrectionWrites';

/**
 * Окно дня на вкладке «Выходные». Повторяет поток окна из TimesheetPage: те же запросы, те же проверки, то же
 * обновление данных при открытии. Страницу «Табель» намеренно не трогаем: 3300 строк без тестов, её правят параллельно.
 * Меняя правила окна там, проверьте и здесь.
 */

const MODAL_WRITE_BLOCKED_MESSAGE = 'Данные дня обновляются — повторите через секунду';

// idle — окно работает как обычно; fetching — идёт перезапрос; applying — ответ получен, ждём завершения запроса
// и подставляем свежую запись; error — перезапрос не удался, правка заблокирована до «Повторить».
type ModalRefreshStatus = 'idle' | 'fetching' | 'applying' | 'error';

interface IWeekendDayCorrectionArgs {
  year: number;
  month: number;
  /** Ответ табеля отдела целиком, без сужения до людей списка. */
  data: TimesheetResponse | undefined;
  queryKey: QueryKey;
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;
  canEdit: boolean;
  /** Окно закрыто: список дней без корректировки пора перечитать. */
  onClosed: () => void;
}

export const useWeekendDayCorrection = ({
  year, month, data, queryKey, dataUpdatedAt, isFetching, refetch, canEdit, onClosed,
}: IWeekendDayCorrectionArgs) => {
  const { profile, showActualHours } = useAuth();
  const toast = useToast();
  const objectEntriesDisabled = profile?.corrections_disable_object_entries === true;
  const correctionCapEnabled = profile?.corrections_cap_by_schedule_norm === true;

  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);
  const [modalMode, setModalMode] = useState<'day' | 'object'>('day');
  const [modalObjectEntry, setModalObjectEntry] = useState<TimesheetObjectEntry | null>(null);
  const [modalObjectTarget, setModalObjectTarget] = useState<IObjectModalTarget | null>(null);
  const [objectPrompt, setObjectPrompt] = useState<IObjectPrompt | null>(null);
  const [modalRefreshStatus, setModalRefreshStatus] = useState<ModalRefreshStatus>('idle');
  const modalRefreshStatusRef = useRef<ModalRefreshStatus>('idle');
  const modalRefreshTokenRef = useRef(0);
  const updateModalRefreshStatus = useCallback((status: ModalRefreshStatus) => {
    modalRefreshStatusRef.current = status;
    setModalRefreshStatus(status);
  }, []);

  const pad = (value: number): string => String(value).padStart(2, '0');
  const modalWorkDate = `${year}-${pad(month)}-${pad(modalDay)}`;
  const schedules = data?.schedules;
  const dailySchedules = data?.daily_schedules;
  const calendar = data?.calendar ?? null;
  const approvalLocks = data?.approval_locks;

  const lockStatusFor = useCallback(
    (employeeId: number, date: string) => weekendLockStatus(approvalLocks ?? [], employeeId, date),
    [approvalLocks],
  );

  const modalObjectsQuery = useQuery({
    queryKey: ['timesheet-employee-objects', modalEmployee?.id ?? null, modalWorkDate, modalEntry?.id ?? null],
    queryFn: () => timesheetService.listEmployeeObjects(modalEmployee!.id, modalWorkDate, modalEntry?.id ?? null),
    enabled: modalOpen && !!modalEmployee && !modalEmployee.view_only,
    staleTime: 60_000,
  });

  const modalLiveSource = useMemo(() => {
    if (!modalOpen || !modalEmployee) return null;
    return pickModalDayData(data?.entries ?? [], data?.object_entries ?? [], modalEmployee.id, modalWorkDate);
  }, [modalOpen, modalEmployee, modalWorkDate, data]);

  const isModalWriteBlocked = (): boolean => {
    if (modalRefreshStatusRef.current === 'idle') return false;
    toast.info(MODAL_WRITE_BLOCKED_MESSAGE);
    return true;
  };

  // При открытии окна перечитываем сетку, если ей больше MODAL_DATA_MAX_AGE_MS; до обновления править нельзя.
  const startModalDataRefresh = () => {
    const wasBlocked = modalRefreshStatusRef.current !== 'idle';
    modalRefreshTokenRef.current += 1;
    const token = modalRefreshTokenRef.current;
    if (!canEdit) {
      updateModalRefreshStatus('idle');
      return;
    }
    const decision = decideModalRefresh([{ dataUpdatedAt, isFetching }], Date.now());
    if (decision !== 'refetch') {
      updateModalRefreshStatus(decision === 'await' || wasBlocked ? 'applying' : 'idle');
      return;
    }
    updateModalRefreshStatus('fetching');
    refetch({ cancelRefetch: false })
      .then((result) => {
        if (token !== modalRefreshTokenRef.current) return;
        updateModalRefreshStatus(result.isError ? 'error' : 'applying');
      })
      .catch(() => {
        if (token !== modalRefreshTokenRef.current) return;
        updateModalRefreshStatus('error');
      });
  };

  // Ответ получен и запрос завершён — подставляем свежую запись дня и открываем правку.
  useEffect(() => {
    if (modalRefreshStatus !== 'applying' || isFetching) return;
    const token = modalRefreshTokenRef.current;
    const freshEntry = modalLiveSource?.entry ?? null;
    const objectKey = modalMode === 'object' ? (modalObjectTarget?.object_key ?? null) : null;
    const freshObjectEntry = objectKey
      ? (modalLiveSource?.objects.find(item => item.object_key === objectKey) ?? null)
      : null;
    queueMicrotask(() => {
      if (token !== modalRefreshTokenRef.current || modalRefreshStatusRef.current !== 'applying') return;
      setModalEntry(freshEntry);
      if (objectKey) setModalObjectEntry(freshObjectEntry);
      updateModalRefreshStatus('idle');
    });
  }, [modalRefreshStatus, isFetching, modalLiveSource, modalMode, modalObjectTarget, updateModalRefreshStatus]);

  const closeModal = () => {
    modalRefreshTokenRef.current += 1;
    updateModalRefreshStatus('idle');
    setModalOpen(false);
    setModalMode('day');
    setModalObjectEntry(null);
    setModalObjectTarget(null);
    onClosed();
  };

  const isDayBlocked = (employee: TimesheetEmployee, day: number): boolean => {
    if (employee.editable === false && canEdit && !employee.view_only) {
      toast.info(resolveReadOnlyReason(employee));
      return true;
    }
    if (isDayCoveredByDepartment(employee, year, month, day) && canEdit) {
      toast.info(COVERED_DAY_MESSAGE);
      return true;
    }
    return false;
  };

  const handleDayClick = (employee: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    if (isDayBlocked(employee, day)) return;
    setModalEmployee(employee);
    setModalDay(day);
    setModalEntry(entry);
    setModalMode('day');
    setModalObjectEntry(null);
    setModalObjectTarget(null);
    setModalOpen(true);
    startModalDataRefresh();
  };

  const handleObjectDayClick = (
    employee: TimesheetEmployee,
    day: number,
    target: IObjectModalTarget,
    objectEntry: TimesheetObjectEntry | null,
  ) => {
    if (objectEntriesDisabled) {
      toast.info(OBJECT_ENTRIES_DISABLED_MESSAGE);
      return;
    }
    if (isDayBlocked(employee, day)) return;
    const workDate = `${year}-${pad(month)}-${pad(day)}`;
    setModalEmployee(employee);
    setModalDay(day);
    setModalEntry(data?.entries.find(item => item.employee_id === employee.id && item.work_date === workDate) ?? null);
    setModalMode('object');
    setModalObjectEntry(objectEntry);
    setModalObjectTarget(target);
    setModalOpen(true);
    startModalDataRefresh();
  };

  const writes = useWeekendCorrectionWrites({
    modalEmployee,
    modalEntry,
    modalMode,
    modalObjectEntry,
    modalObjectTarget,
    modalWorkDate,
    objectPrompt,
    objectEntriesDisabled,
    queryKey,
    setModalEntry,
    setModalMode,
    setModalObjectEntry,
    setModalObjectTarget,
    setObjectPrompt,
    closeModal,
    isModalWriteBlocked,
  });

  const modalDefaultHours = useMemo(() => {
    // Дефолт поля «Часы» уважает show_actual_hours роли: иначе в сетке 14 ч, а в форме 9.
    if (modalMode === 'object') {
      const visible = selectVisibleObjectHours(modalObjectEntry ?? null, showActualHours);
      if (visible > 0) return visible;
      return modalObjectEntry?.base_hours_worked ?? 0;
    }
    // Авто-удалёнка несёт часы графика без предпраздничного −1 — подставляем норму дня, как в пустой день.
    const autoRemote = modalEntry?.status === 'remote' && !modalEntry.is_correction;
    const visible = autoRemote ? null : selectVisibleHours(modalEntry ?? null, showActualHours);
    if (visible != null) return visible;
    if (!modalEmployee) return 8;
    const schedule = getScheduleForTimesheetDay(schedules ?? {}, dailySchedules ?? {}, modalEmployee.id, year, month, modalDay);
    return getCorrectionDefaultHoursForDay(schedule, calendar, year, month, modalDay);
  }, [modalMode, modalObjectEntry, modalEntry, modalEmployee, schedules, dailySchedules, calendar, year, month, modalDay, showActualHours]);

  const modalMaxHours = useMemo(() => {
    if (!correctionCapEnabled || !modalEmployee) return null;
    const schedule = getScheduleForTimesheetDay(schedules ?? {}, dailySchedules ?? {}, modalEmployee.id, year, month, modalDay);
    return getCorrectionMaxHoursForDay(schedule, calendar, year, month, modalDay);
  }, [correctionCapEnabled, modalEmployee, schedules, dailySchedules, calendar, year, month, modalDay]);

  return {
    year,
    month,
    schedules: schedules ?? {},
    dailySchedules: dailySchedules ?? {},
    calendar,
    canEdit,
    objectEntriesDisabled,
    lockStatusFor,
    handleDayClick,
    handleObjectDayClick,
    modalOpen,
    modalEmployee,
    modalDay,
    modalEntry,
    modalMode,
    modalObjectEntry,
    modalObjectTarget,
    modalWorkDate,
    modalRefreshStatus,
    modalLiveSource,
    modalObjects: modalObjectsQuery.data ?? null,
    modalDefaultHours,
    modalMaxHours,
    objectPrompt,
    setObjectPrompt,
    closeModal,
    startModalDataRefresh,
    ...writes,
  };
};

export type IWeekendDayCorrection = ReturnType<typeof useWeekendDayCorrection>;
