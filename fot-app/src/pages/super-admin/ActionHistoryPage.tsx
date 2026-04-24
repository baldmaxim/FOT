import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { actionHistoryApi } from '../../api/actionHistory';
import styles from './ActionHistoryPage.module.css';

const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Вход в систему',
  LOGOUT: 'Выход из системы',
  LOGIN_FAILED: 'Ошибка входа',
  PASSWORD_RESET_REQUESTED: 'Запрос сброса пароля',
  PASSWORD_RESET_COMPLETED: 'Сброс пароля',
  '2FA_ENABLED': '2FA включена',
  '2FA_DISABLED': '2FA отключена',
  '2FA_VERIFIED': '2FA подтверждена',
  '2FA_FAILED': 'Ошибка 2FA',
  USER_APPROVED: 'Пользователь одобрен',
  USER_REJECTED: 'Пользователь отклонён',
  USER_DELETED: 'Пользователь удалён',
  EMAIL_CONFIRMED: 'Email подтверждён',
  POSITION_CHANGED: 'Должность изменена',
  ROLE_CHANGED: 'Роль изменена',
  CHAT_INBOUND_MODE_CHANGED: 'Режим чата изменён',
  ORG_ASSIGNED: 'Организация назначена',
  NAME_CHANGED: 'Имя изменено',
  USER_DEPARTMENT_ACCESS_CHANGED: 'Доступ к отделу изменён',
  ORG_CREATED: 'Отдел создан',
  ORG_UPDATED: 'Отдел обновлён',
  ORG_DELETED: 'Отдел удалён',
  VIEW_EMPLOYEES: 'Просмотр сотрудников',
  CREATE_EMPLOYEE: 'Сотрудник создан',
  UPDATE_EMPLOYEE: 'Сотрудник обновлён',
  DELETE_EMPLOYEE: 'Сотрудник удалён',
  DELETE_ALL_EMPLOYEES: 'Все сотрудники удалены',
  ARCHIVE_EMPLOYEE: 'Сотрудник архивирован',
  RESTORE_EMPLOYEE: 'Сотрудник восстановлен',
  FIRE_EMPLOYEE: 'Сотрудник уволен',
  REHIRE_EMPLOYEE: 'Сотрудник принят повторно',
  MOVE_EMPLOYEE_DEPARTMENT: 'Перевод в отдел',
  IMPORT_EMPLOYEES: 'Импорт сотрудников',
  ENRICH_EMPLOYEES: 'Обогащение данных',
  ENRICH_EMPLOYEES_CONTACTS: 'Обогащение контактов',
  CREATE_ORG_DEPARTMENT: 'Создан подразделение',
  UPDATE_ORG_DEPARTMENT: 'Подразделение обновлено',
  DELETE_ORG_DEPARTMENT: 'Подразделение удалено',
  MOVE_ORG_DEPARTMENT_BATCH: 'Подразделения перемещены',
  DELETE_ORG_DEPARTMENT_RECURSIVE: 'Подразделение удалено рекурсивно',
  CLEAR_STRUCTURE: 'Структура очищена',
  VIEW_TIMESHEET: 'Просмотр табеля',
  CREATE_TIMESHEET_ENTRY: 'Запись в табель',
  UPDATE_TIMESHEET_ENTRY: 'Табель обновлён',
  IMPORT_TIMESHEET: 'Табель импортирован',
  TIMESHEET_APPROVAL_SUBMITTED: 'Табель подан',
  TIMESHEET_APPROVAL_APPROVED: 'Табель утверждён',
  TIMESHEET_APPROVAL_REJECTED: 'Табель отклонён',
  TIMESHEET_APPROVAL_RETURNED_TO_REWORK: 'Табель возвращён на доработку',
  VIEW_SKUD: 'Просмотр СКУД',
  IMPORT_SKUD: 'СКУД импортирован',
  CLEAR_SKUD: 'СКУД очищен',
  CLEAN_SKUD_DUPLICATES: 'Дубликаты СКУД удалены',
  SYNC_SIGUR: 'Синхронизация Sigur',
  SYNC_SIGUR_EMPLOYEE: 'Синхронизация сотрудника Sigur',
  MATCH_EMPLOYEES: 'Сотрудники сопоставлены',
  VIEW_SALARY: 'Просмотр зарплаты',
  UPDATE_SALARY: 'Зарплата обновлена',
  ENRICH_SALARY: 'Обогащение зарплат',
  ENRICH_SALARY_HISTORY: 'Обогащение истории зарплат',
};

const ACTION_GROUPS: Record<string, string[]> = {
  'Аутентификация': ['LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', '2FA_ENABLED', '2FA_DISABLED', '2FA_VERIFIED', '2FA_FAILED'],
  'Пользователи': ['USER_APPROVED', 'USER_REJECTED', 'USER_DELETED', 'EMAIL_CONFIRMED', 'POSITION_CHANGED', 'ROLE_CHANGED', 'NAME_CHANGED', 'USER_DEPARTMENT_ACCESS_CHANGED', 'CHAT_INBOUND_MODE_CHANGED', 'ORG_ASSIGNED'],
  'Сотрудники': ['VIEW_EMPLOYEES', 'CREATE_EMPLOYEE', 'UPDATE_EMPLOYEE', 'DELETE_EMPLOYEE', 'DELETE_ALL_EMPLOYEES', 'ARCHIVE_EMPLOYEE', 'RESTORE_EMPLOYEE', 'FIRE_EMPLOYEE', 'REHIRE_EMPLOYEE', 'MOVE_EMPLOYEE_DEPARTMENT', 'IMPORT_EMPLOYEES', 'ENRICH_EMPLOYEES', 'ENRICH_EMPLOYEES_CONTACTS'],
  'Структура': ['ORG_CREATED', 'ORG_UPDATED', 'ORG_DELETED', 'CREATE_ORG_DEPARTMENT', 'UPDATE_ORG_DEPARTMENT', 'DELETE_ORG_DEPARTMENT', 'MOVE_ORG_DEPARTMENT_BATCH', 'DELETE_ORG_DEPARTMENT_RECURSIVE', 'CLEAR_STRUCTURE'],
  'Табель': ['VIEW_TIMESHEET', 'CREATE_TIMESHEET_ENTRY', 'UPDATE_TIMESHEET_ENTRY', 'IMPORT_TIMESHEET', 'TIMESHEET_APPROVAL_SUBMITTED', 'TIMESHEET_APPROVAL_APPROVED', 'TIMESHEET_APPROVAL_REJECTED', 'TIMESHEET_APPROVAL_RETURNED_TO_REWORK'],
  'СКУД / Sigur': ['VIEW_SKUD', 'IMPORT_SKUD', 'CLEAR_SKUD', 'CLEAN_SKUD_DUPLICATES', 'SYNC_SIGUR', 'SYNC_SIGUR_EMPLOYEE', 'MATCH_EMPLOYEES'],
  'Зарплата': ['VIEW_SALARY', 'UPDATE_SALARY', 'ENRICH_SALARY', 'ENRICH_SALARY_HISTORY'],
};

const PAGE_SIZE = 50;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function actionClass(action: string): string {
  if (['LOGIN_FAILED', '2FA_FAILED', 'USER_REJECTED', 'DELETE_EMPLOYEE', 'DELETE_ALL_EMPLOYEES', 'FIRE_EMPLOYEE', 'CLEAR_SKUD', 'CLEAR_STRUCTURE'].includes(action)) return styles.tagDanger;
  if (['LOGIN', '2FA_VERIFIED', 'USER_APPROVED', 'CREATE_EMPLOYEE', 'TIMESHEET_APPROVAL_APPROVED'].includes(action)) return styles.tagSuccess;
  if (['UPDATE_EMPLOYEE', 'UPDATE_SALARY', 'TIMESHEET_APPROVAL_SUBMITTED', 'SYNC_SIGUR'].includes(action)) return styles.tagInfo;
  return styles.tagDefault;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function formatDetails(action: string, details: Record<string, unknown> | null): string {
  if (!details || typeof details !== 'object') return '';

  const fio = asString(details.employee_full_name) || asString(details.full_name);

  switch (action) {
    case 'MOVE_EMPLOYEE_DEPARTMENT': {
      const from = asString(details.from_department_name) || asString(details.from_department_id) || '—';
      const to = asString(details.to_department_name) || asString(details.to_department_id) || asString(details.org_department_id) || '—';
      const prefix = fio ? `${fio}: ` : '';
      return `${prefix}«${from}» → «${to}»`;
    }
    case 'CREATE_EMPLOYEE': {
      const dept = asString(details.department_name) || asString(details.org_department_id);
      if (fio && dept) return `${fio}, отдел «${dept}»`;
      return fio || dept || '';
    }
    case 'FIRE_EMPLOYEE':
    case 'REHIRE_EMPLOYEE':
    case 'ARCHIVE_EMPLOYEE':
    case 'RESTORE_EMPLOYEE':
    case 'DELETE_EMPLOYEE': {
      const reason = asString(details.reason);
      if (fio && reason) return `${fio}, причина: ${reason}`;
      return fio || '';
    }
    case 'UPDATE_SALARY': {
      const from = asString(details.old_salary) || asString(details.from);
      const to = asString(details.new_salary) || asString(details.to);
      if (fio && from && to) return `${fio}: ${from} → ${to} ₽`;
      if (from && to) return `${from} → ${to} ₽`;
      return fio || '';
    }
    case 'POSITION_CHANGED':
    case 'ROLE_CHANGED':
    case 'NAME_CHANGED': {
      const from = asString(details.from) || asString(details.old) || asString(details.previous);
      const to = asString(details.to) || asString(details.new) || asString(details.current);
      if (from && to) return `«${from}» → «${to}»`;
      return to || from || '';
    }
    case 'UPDATE_EMPLOYEE': {
      const fields = Array.isArray(details.changed_fields) ? details.changed_fields : null;
      if (fields && fields.length > 0) {
        return `Изменены: ${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` (+${fields.length - 3})` : ''}`;
      }
      return fio || '';
    }
    default: {
      try {
        const json = JSON.stringify(details);
        return json.length > 80 ? `${json.slice(0, 80)}…` : json;
      } catch {
        return '';
      }
    }
  }
}

export const ActionHistoryPage: FC = () => {
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['action-history', action, dateFrom, dateTo, page],
    queryFn: () => actionHistoryApi.getLogs({
      action: action || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    staleTime: 30_000,
    placeholderData: prev => prev,
  });

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleFilterChange = () => setPage(1);

  return (
    <div className={styles.page}>
      <div className={styles.filters}>
        <select
          className={styles.select}
          value={action}
          onChange={e => { setAction(e.target.value); handleFilterChange(); }}
        >
          <option value="">Все действия</option>
          {Object.entries(ACTION_GROUPS).map(([group, actions]) => (
            <optgroup key={group} label={group}>
              {actions.map(a => (
                <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <input
          type="date"
          className={styles.input}
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); handleFilterChange(); }}
          title="С даты"
        />
        <input
          type="date"
          className={styles.input}
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); handleFilterChange(); }}
          title="По дату"
        />

        {(action || dateFrom || dateTo) && (
          <button
            className={styles.btnClear}
            onClick={() => { setAction(''); setDateFrom(''); setDateTo(''); setPage(1); }}
          >
            Сбросить
          </button>
        )}

        <span className={styles.total}>
          {isLoading ? '…' : `${total.toLocaleString('ru')} записей`}
        </span>
      </div>

      {isError && <div className={styles.error}>Ошибка загрузки истории действий</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Дата и время</th>
              <th>Пользователь</th>
              <th>Действие</th>
              <th>Подробности</th>
              <th>Объект</th>
              <th>ID объекта</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className={styles.loading}>Загрузка…</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.empty}>Записей не найдено</td>
              </tr>
            ) : logs.map(log => {
              const detailsText = formatDetails(log.action, log.details);
              const detailsTitle = log.details ? JSON.stringify(log.details, null, 2) : undefined;
              return (
                <tr key={log.id}>
                  <td className={styles.date}>{formatDate(log.created_at)}</td>
                  <td className={styles.user}>{log.user_name ?? <span className={styles.muted}>—</span>}</td>
                  <td>
                    <span className={`${styles.tag} ${actionClass(log.action)}`}>
                      {actionLabel(log.action)}
                    </span>
                  </td>
                  <td title={detailsTitle}>
                    {detailsText || <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.muted}>{log.entity_type ?? '—'}</td>
                  <td className={styles.muted}>{log.entity_id ?? '—'}</td>
                  <td className={styles.ip}>{log.ip_address ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            ‹
          </button>
          <span className={styles.pageInfo}>
            {page} / {totalPages}
          </span>
          <button
            className={styles.pageBtn}
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
};
