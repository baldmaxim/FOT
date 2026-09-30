import { useEffect, useState, type FC } from 'react';
import { X } from 'lucide-react';
import { adminService, type ITimesheetOfficeEmployee } from '../../services/adminService';
import styles from './StaffTimesheetOfficeModal.module.css';

const SEARCH_MIN_LENGTH = 2;
const SEARCH_DELAY_MS = 300;

interface ITimesheetOfficeEmployeeSearchProps {
  value: ITimesheetOfficeEmployee | null;
  onChange: (employee: ITimesheetOfficeEmployee | null) => void;
  disabled?: boolean;
}

/**
 * Поиск сотрудника по ФИО для окна «Режим табелирования» (миграция 291): свои работающие,
 * без подрядчиков, в доступе пользователя (фильтрует сервер). Подсказки — списком под полем,
 * выбранный — строкой с крестиком.
 */
export const TimesheetOfficeEmployeeSearch: FC<ITimesheetOfficeEmployeeSearchProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const [query, setQuery] = useState('');
  // Ответ сервера вместе с запросом, на который он пришёл: устаревший не показываем.
  const [fetched, setFetched] = useState<{ term: string; rows: ITimesheetOfficeEmployee[] } | null>(null);
  const term = query.trim();
  const active = term.length >= SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      adminService.searchTimesheetOfficeEmployees(term, controller.signal)
        .then(rows => { if (!controller.signal.aborted) setFetched({ term, rows }); })
        .catch(() => { if (!controller.signal.aborted) setFetched({ term, rows: [] }); });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, term]);

  const loading = active && fetched?.term !== term;
  const results = active && fetched?.term === term ? fetched.rows : [];

  if (value) {
    return (
      <div className={styles.picked}>
        <span className={styles.pickedText}>
          {value.full_name}
          {value.department && <span className={styles.muted}> — {value.department}</span>}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onChange(null)}
          disabled={disabled}
          aria-label="Очистить"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className={styles.search}>
      <input
        className={styles.input}
        type="text"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Поиск по ФИО"
        disabled={disabled}
        aria-label="Поиск по ФИО"
        autoComplete="off"
      />
      {active && (
        <ul className={styles.results} role="listbox" aria-label="Сотрудники">
          {loading && <li className={styles.hint}>Поиск…</li>}
          {!loading && results.length === 0 && <li className={styles.hint}>Не найдено</li>}
          {!loading && results.map(employee => (
            <li key={employee.id}>
              <button
                type="button"
                className={styles.resultButton}
                onClick={() => {
                  onChange(employee);
                  setQuery('');
                }}
                disabled={disabled}
              >
                <span>{employee.full_name}</span>
                {employee.department && <span className={styles.muted}>{employee.department}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
