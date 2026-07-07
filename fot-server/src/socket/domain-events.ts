// Источник истины для имён domain-событий Socket.IO (этап realtime-обновлений).
// Фронтовый аналог: fot-app/src/services/realtimeEvents.ts — должен совпадать строчка-в-строчку.
//
// Старые каналы (chat new_message, notification_new/count, structure_updated,
// presence_updated, profile:access_changed, official_memo_*, leave_request_notification,
// leave_request_pending_changed, salary_raise_notification) живут отдельно и сюда НЕ добавляются.

export const DOMAIN_EVENTS = [
  'leave_request:changed',
  'correction:changed',
  'timesheet_approval:changed',
  'daily_task:changed',
  'schedule:changed',
  'employee:changed',
  'salary_raise:changed',
  'payslip:changed',
  'payment:changed',
  'patent_receipt:changed',
  'production_calendar:changed',
  'contractor_induction:changed',
] as const;

export type DomainEvent = typeof DOMAIN_EVENTS[number];

export interface IDomainEventPayload {
  entityId?: string | number;
  employeeId?: number;
  action?: string;
  [key: string]: unknown;
}
