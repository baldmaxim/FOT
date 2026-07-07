// Источник истины для имён domain-событий Socket.IO (фронтовая копия).
// Должна совпадать строчка-в-строчку с fot-server/src/socket/domain-events.ts.
//
// Старые каналы (chat, notification_new/count, structure_updated, presence_updated,
// profile:access_changed, official_memo_*, leave_request_notification,
// leave_request_pending_changed, salary_raise_notification) живут отдельно.

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
  at?: string;
  [key: string]: unknown;
}
