import { Fragment, memo, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchInput } from '../ui/SearchInput';
import { EmployeeTrainingsPanel } from './EmployeeTrainingsPanel';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useAuth } from '../../contexts/AuthContext';
import {
  employeeInductionService,
  type IInductionRow,
  type InductionStatusFilter,
} from '../../services/employeeInductionService';
import styles from './EmployeeInductionTab.module.css';

const PAGE_SIZE = 100;

const STATUS_OPTIONS: Array<{ key: InductionStatusFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'missing', label: 'Без инструктажа' },
  { key: 'passed', label: 'Пройден' },
];

interface IRowProps {
  row: IInductionRow;
  index: number;
  canEdit: boolean;
  isOpen: boolean;
  onToggle: (employeeId: number) => void;
}

const InductionRow: FC<IRowProps> = memo(({ row, index, canEdit, isOpen, onToggle }) => (
  <Fragment>
    <tr
      className={styles.clickableRow}
      onClick={() => onToggle(row.employee_id)}
      title={isOpen ? 'Скрыть обучение' : 'Показать обучение'}
    >
      <td className={styles.num}>{index}</td>
      <td>
        <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
        {row.full_name || '—'}
      </td>
      <td className={`${styles.muted} ${styles.hideNarrow}`}>{row.department_name || '—'}</td>
      <td className={`${styles.muted} ${styles.hideNarrow}`}>{row.position_name || '—'}</td>
    </tr>
    {isOpen && (
      <tr>
        <td colSpan={4} className={styles.panelCell}>
          <EmployeeTrainingsPanel employeeId={row.employee_id} canEdit={canEdit} />
        </td>
      </tr>
    )}
  </Fragment>
));

InductionRow.displayName = 'InductionRow';

/**
 * Вкладка «Вводный инструктаж»: свои сотрудники (СУ-10 + Служба Механизации). Клик по строке
 * раскрывает панель обучения по ОТ — весь цикл регламента с датами и сроками действия.
 * Даты правит служба ОТиТБ (право /staff-control/induction edit), остальные смотрят.
 */
export const EmployeeInductionTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();

  const canEdit = isAdmin || canEditPage('/staff-control/induction');

  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState<InductionStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300).trim();

  const listParams = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      departmentId: departmentId || undefined,
      search: debouncedSearch || undefined,
      status,
    }),
    [page, departmentId, debouncedSearch, status],
  );

  const listQuery = useQuery({
    queryKey: ['employee-induction', listParams],
    queryFn: () => employeeInductionService.list(listParams),
    placeholderData: previous => previous,
  });

  const departmentsQuery = useQuery({
    queryKey: ['employee-induction-departments'],
    queryFn: () => employeeInductionService.departments(),
    staleTime: 30 * 60_000,
  });

  const rows = listQuery.data?.data ?? [];
  const meta = listQuery.data?.meta;
  const departments = departmentsQuery.data ?? [];
  const totalPages = meta?.totalPages ?? 0;

  // Смена фильтра/страницы схлопывает панель: раскрытая строка уехала бы к чужому сотруднику.
  const resetPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
    setExpanded(null);
  };

  const toggle = (employeeId: number) =>
    setExpanded(prev => (prev === employeeId ? null : employeeId));

  return (
    <div className={styles.wrap}>
      <div className={styles.filters}>
        <SearchInput
          className={styles.search}
          value={search}
          onValueChange={resetPage(setSearch)}
          placeholder="Поиск по ФИО..."
        />

        <select
          className={styles.select}
          value={departmentId}
          onChange={e => resetPage(setDepartmentId)(e.target.value)}
          aria-label="Отдел"
        >
          <option value="">Все отделы</option>
          {departments.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <div className={styles.seg} role="tablist">
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.key}
              type="button"
              role="tab"
              aria-selected={status === opt.key}
              className={`${styles.segBtn} ${status === opt.key ? styles.segBtnActive : ''}`}
              onClick={() => resetPage(setStatus)(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {meta && (
          <span className={styles.counter}>
            Пройдено {meta.passed} из {meta.total}
          </span>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.num}>№</th>
              <th>ФИО</th>
              <th className={styles.hideNarrow}>Отдел</th>
              <th className={styles.hideNarrow}>Должность</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <InductionRow
                key={row.employee_id}
                row={row}
                index={(page - 1) * PAGE_SIZE + i + 1}
                canEdit={canEdit}
                isOpen={expanded === row.employee_id}
                onToggle={toggle}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  {listQuery.isPending ? 'Загрузка…' : 'Сотрудники не найдены'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.pagerBtn}
            onClick={() => { setPage(p => Math.max(1, p - 1)); setExpanded(null); }}
            disabled={page <= 1}
          >
            Назад
          </button>
          <span className={styles.pagerInfo}>Стр. {page} из {totalPages}</span>
          <button
            type="button"
            className={styles.pagerBtn}
            onClick={() => { setPage(p => Math.min(totalPages, p + 1)); setExpanded(null); }}
            disabled={page >= totalPages}
          >
            Вперёд
          </button>
        </div>
      )}
    </div>
  );
};

export default EmployeeInductionTab;
