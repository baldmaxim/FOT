/** Ошибка окна «Режим табелирования» (миграции 291, 358): статус HTTP, код и подробности. */
export type TimesheetOfficeErrorCode =
  | 'TIMESHEET_OFFICE_INVALID'
  | 'TIMESHEET_OFFICE_FORBIDDEN'
  | 'TIMESHEET_OFFICE_MONTH_NOT_FROZEN'
  | 'TIMESHEET_OFFICE_CHANGED'
  | 'TIMESHEET_OFFICE_BUSY';

export class TimesheetOfficeError extends Error {
  readonly status: number;
  readonly code: TimesheetOfficeErrorCode;
  readonly details: unknown;

  constructor(status: number, code: TimesheetOfficeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TimesheetOfficeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
