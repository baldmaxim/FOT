/**
 * Надгробный профиль «Удалённый пользователь» (миграция 284).
 *
 * При удалении учётки авторские ссылки (кто согласовал, отменил, загрузил)
 * перевешиваются на него средствами БД — FK с ON DELETE SET DEFAULT, где
 * DEFAULT равен этому id. Благодаря этому деловые строки не исчезают, NOT NULL
 * не снимается, а интерфейс вместо ФИО показывает «Удалённый пользователь».
 *
 * Сам профиль удалять нельзя: без него SET DEFAULT начнёт нарушать FK.
 */
export const TOMBSTONE_USER_ID = '00000000-0000-0000-0000-00000000dead';

export const TOMBSTONE_USER_NAME = 'Удалённый пользователь';

export const isTombstoneUser = (id: string | null | undefined): boolean =>
  typeof id === 'string' && id.toLowerCase() === TOMBSTONE_USER_ID;

/**
 * Человеческие названия таблиц для сообщения об отказе удалить пользователя.
 * Сырое имя из ошибки Postgres наружу не отдаём — показываем либо перевод,
 * либо общую формулировку.
 */
const TABLE_LABELS: Record<string, string> = {
  attendance_adjustments: 'корректировки табеля',
  audit_logs: 'журнал действий',
  chat_messages: 'сообщения в чате',
  contractor_submissions: 'подачи подрядчиков',
  contractor_submission_decisions: 'решения по подачам подрядчиков',
  documents: 'документы',
  employee_hr_profiles: 'кадровые карточки',
  hiring_candidates: 'кандидаты на подбор',
  hiring_requests: 'заявки на подбор',
  hiring_request_events: 'события заявок на подбор',
  hiring_request_files: 'файлы заявок на подбор',
  leave_requests: 'заявления',
  leave_request_history: 'история заявлений',
  official_memos: 'служебные записки',
  patent_payment_receipts: 'чеки за патент',
  payments: 'платежи',
  payslips: 'расчётные листки',
  person_blacklist: 'чёрный список',
  salary_raise_requests: 'заявки на повышение оклада',
  timesheet_approvals: 'согласования табелей',
  timesheet_approval_events: 'события согласования табелей',
  timesheet_versions: 'версии табелей',
};

export const describeBlockingTable = (table: string | null | undefined): string =>
  (table && TABLE_LABELS[table]) || 'связанные записи';
