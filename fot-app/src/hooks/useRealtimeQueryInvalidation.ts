import { useEffect, useRef } from 'react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { wsService } from '../services/websocket';
import { DOMAIN_EVENTS, type DomainEvent, type IDomainEventPayload } from '../services/realtimeEvents';
import {
  employeesKeys,
  patentReceiptsKeys,
  structureKeys,
  timesheetKeys,
} from '../api/queryKeys';

// Глобальный listener domain-событий Socket.IO.
// Принцип: эвент → набор queryKey → дедуп по JSON.stringify → invalidate с refetchType:'active'.
// Один tick = одна волна invalidate (даже если на бэке bulk-эмит 50 раз).

const FLUSH_DELAY_MS = 120;

type EventToKeysFn = (payload: IDomainEventPayload) => QueryKey[];

const EVENT_TO_KEYS: Record<DomainEvent, EventToKeysFn> = {
  'leave_request:changed': (payload) => {
    const keys: QueryKey[] = [
      ['leave-requests-manage'],
      ['my-leave-requests'],
      ['leave-requests-vacations'],
    ];
    if (payload.entityId != null) {
      keys.push(['leave-request', payload.entityId]);
    }
    return keys;
  },
  'correction:changed': () => [
    ['correction-approvals'],
    ['approval-timesheet'],
    timesheetKeys.corrections(),
    timesheetKeys.page(),
  ],
  'timesheet_approval:changed': () => [
    timesheetKeys.approval(),
    // Сетка табеля держит блокировки дней из статусов согласования — обновляем и её,
    // чтобы блокировка/разблокировка приходила в другие вкладки и другим пользователям.
    timesheetKeys.page(),
    ['approvals-review-list'],
  ],
  'daily_task:changed': (payload) => {
    const keys: QueryKey[] = [['daily-tasks']];
    if (payload.employeeId != null) {
      keys.push(['daily-tasks', payload.employeeId]);
    }
    return keys;
  },
  'schedule:changed': (payload) => {
    const keys: QueryKey[] = [
      ['schedules'],
      timesheetKeys.page(),
    ];
    if (payload.employeeId != null) {
      keys.push(['employee-schedule', payload.employeeId]);
    }
    return keys;
  },
  'employee:changed': (payload) => {
    const keys: QueryKey[] = [
      employeesKeys.all,
      structureKeys.all,
    ];
    if (payload.entityId != null) {
      keys.push(employeesKeys.byId(payload.entityId as number | string));
    }
    return keys;
  },
  'salary_raise:changed': () => [['salary-raise']],
  'payslip:changed': () => [['my-payslips']],
  'payment:changed': () => [['my-payments']],
  'patent_receipt:changed': (payload) => {
    const keys: QueryKey[] = [patentReceiptsKeys.all];
    if (payload.entityId != null) {
      keys.push(patentReceiptsKeys.byId(payload.entityId as number | string));
    }
    return keys;
  },
  'production_calendar:changed': () => [
    ['production-calendar'],
    timesheetKeys.page(),
  ],
};

export interface IUseRealtimeQueryInvalidationOptions {
  enabled: boolean;
  queryClient: QueryClient;
  // Сотрудник текущего пользователя — для спец-обработки employee:changed (fire/rehire → refresh profile).
  myEmployeeId?: number | null;
  onMyEmploymentChanged?: () => void;
}

export const useRealtimeQueryInvalidation = ({
  enabled,
  queryClient,
  myEmployeeId,
  onMyEmploymentChanged,
}: IUseRealtimeQueryInvalidationOptions): void => {
  const pendingRef = useRef<Map<string, QueryKey>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myEmployeeIdRef = useRef(myEmployeeId);
  const onMyEmploymentChangedRef = useRef(onMyEmploymentChanged);

  useEffect(() => { myEmployeeIdRef.current = myEmployeeId; }, [myEmployeeId]);
  useEffect(() => { onMyEmploymentChangedRef.current = onMyEmploymentChanged; }, [onMyEmploymentChanged]);

  useEffect(() => {
    if (!enabled) return undefined;

    const scheduleInvalidate = (keys: QueryKey[]) => {
      for (const key of keys) {
        const k = JSON.stringify(key);
        if (!pendingRef.current.has(k)) {
          pendingRef.current.set(k, key);
        }
      }
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const keysToFlush = Array.from(pendingRef.current.values());
        pendingRef.current.clear();
        for (const key of keysToFlush) {
          void queryClient.invalidateQueries({ queryKey: key, refetchType: 'active' });
        }
      }, FLUSH_DELAY_MS);
    };

    const unsubscribes: Array<() => void> = [];
    for (const event of DOMAIN_EVENTS) {
      const off = wsService.on(event, (raw: unknown) => {
        const payload: IDomainEventPayload = (raw && typeof raw === 'object') ? (raw as IDomainEventPayload) : {};
        // Спец-кейс: смена employment_status у меня самого — нужно перечитать /auth/me.
        if (
          event === 'employee:changed'
          && myEmployeeIdRef.current != null
          && Number(payload.entityId) === Number(myEmployeeIdRef.current)
          && (payload.action === 'fire' || payload.action === 'rehire' || payload.action === 'transfer')
        ) {
          onMyEmploymentChangedRef.current?.();
        }

        const keys = EVENT_TO_KEYS[event](payload);
        scheduleInvalidate(keys);
      });
      unsubscribes.push(off);
    }

    return () => {
      for (const off of unsubscribes) off();
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current.clear();
    };
  }, [enabled, queryClient]);
};
