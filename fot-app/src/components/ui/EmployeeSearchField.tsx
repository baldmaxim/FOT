import { useEffect, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';

import { ClearableInput } from './ClearableInput';
import styles from './EmployeeSearchField.module.css';

const SEARCH_MIN_LENGTH = 2;
const SEARCH_DELAY_MS = 300;

/** Кандидат в подсказке: ФИО, отдел и должность — подпись под ФИО. */
export interface IEmployeeSearchCandidate {
  id: number;
  full_name: string | null;
  department?: string | null;
  position?: string | null;
}

interface IEmployeeSearchFieldProps<T extends IEmployeeSearchCandidate> {
  value: T | null;
  onChange: (employee: T | null) => void;
  /** Поиск на сервере (охват фильтрует сервер); term — от 2 символов. */
  search: (term: string, signal: AbortSignal) => Promise<T[]>;
  /** Кандидата нельзя выбрать (нет права на сотрудника): строка неактивна. */
  isDisabled?: (employee: T) => boolean;
  disabled?: boolean;
  invalid?: boolean;
}

/**
 * Поиск сотрудника по ФИО для «Добавить сотрудника» (образец — TimesheetOfficeEmployeeSearch): общежитие
 * и таблицы «Справочника» «Зарплаты». Подсказки — списком под полем, выбранный — строкой с крестиком.
 */
export const EmployeeSearchField = <T extends IEmployeeSearchCandidate>({
  value,
  onChange,
  search,
  isDisabled,
  disabled = false,
  invalid = false,
}: IEmployeeSearchFieldProps<T>): ReactElement => {
  const [query, setQuery] = useState('');
  // Ответ сервера вместе с запросом, на который он пришёл: устаревший не показываем.
  const [fetched, setFetched] = useState<{ term: string; rows: T[] } | null>(null);
  const term = query.trim();
  const active = term.length >= SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      search(term, controller.signal)
        .then(rows => { if (!controller.signal.aborted) setFetched({ term, rows }); })
        .catch(() => { if (!controller.signal.aborted) setFetched({ term, rows: [] }); });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, term, search]);

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
          aria-label="Выбрать другого сотрудника"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className={styles.search}>
      <ClearableInput
        value={query}
        onValueChange={setQuery}
        placeholder="Поиск по ФИО"
        disabled={disabled}
        aria-label="Поиск сотрудника по ФИО"
        aria-invalid={invalid || undefined}
        autoComplete="off"
        autoFocus
        clearLabel="Очистить поиск"
      />
      {active && (
        <ul className={styles.results} aria-label="Сотрудники">
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
                disabled={disabled || (isDisabled?.(employee) ?? false)}
              >
                <span>{employee.full_name}</span>
                {(employee.department || employee.position) && (
                  <span className={styles.muted}>
                    {[employee.department, employee.position].filter(Boolean).join(' · ')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
