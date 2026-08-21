import { useEffect, useRef, useState, type FC } from 'react';
import { ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { timesheetService } from '../../services/timesheetService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface ITimesheetEmployeePickerProps {
  /** Подпись кнопки: ФИО выбранного либо приглашение к выбору. */
  label: string;
  selectedEmployeeId: number | null;
  /** Диапазон активного полумесяца — доступ к сотруднику считается именно на нём. */
  from: string;
  to: string;
  onSelect: (employeeId: number, fullName: string) => void;
}

/**
 * Выбор сотрудника для режима «По сотруднику». Поиск идёт на сервере и уже
 * ограничен скоупом роли: локальной фильтрации по загруженному списку нет —
 * сотрудников тысячи, а чужие ФИО не должны попадать на клиент вовсе.
 */
export const TimesheetEmployeePicker: FC<ITimesheetEmployeePickerProps> = ({
  label,
  selectedEmployeeId,
  from,
  to,
  onSelect,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const searchQuery = useQuery({
    queryKey: ['timesheet-employee-search', debouncedSearch, from, to],
    queryFn: () => timesheetService.searchEmployees({ q: debouncedSearch, from, to }),
    enabled: open && debouncedSearch.length >= 2,
    staleTime: 60_000,
  });

  const results = searchQuery.data ?? [];

  return (
    <div className="ts-dept-wrap" ref={wrapRef}>
      <button type="button" className="ts-dept-btn" onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="ts-dept-dropdown ts-assignee-dropdown">
          <input
            className="ts-dept-search"
            placeholder="Поиск по ФИО..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {debouncedSearch.length < 2 ? (
            <div className="ts-dept-item ts-dept-item--muted">Введите минимум 2 символа</div>
          ) : searchQuery.isLoading ? (
            <div className="ts-dept-item ts-dept-item--muted">Поиск...</div>
          ) : searchQuery.isError ? (
            <div className="ts-dept-item ts-dept-item--muted">Ошибка поиска</div>
          ) : results.length === 0 ? (
            <div className="ts-dept-item ts-dept-item--muted">Никого не найдено</div>
          ) : results.map(employee => (
            <div
              key={employee.id}
              className={`ts-dept-item ts-assignee-item ${selectedEmployeeId === employee.id ? 'ts-dept-item--active' : ''}`}
              onClick={() => {
                onSelect(employee.id, employee.full_name);
                setOpen(false);
                setSearch('');
              }}
            >
              <span className="ts-assignee-name">{formatTimesheetEmployeeName(employee.full_name)}</span>
              {employee.department_name && (
                <span className="ts-assignee-badge" title={employee.department_name}>
                  {employee.department_name}
                </span>
              )}
              {employee.employment_status === 'fired' && (
                <span className="ts-assignee-badge" title="Уволен">Уволен</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
