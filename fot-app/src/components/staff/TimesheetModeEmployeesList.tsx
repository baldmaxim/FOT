import { useEffect, useMemo, useState, type FC } from 'react';
import type { ITimesheetModeEmployee } from '../../services/adminService';
import { usePaginatedEmployeesQuery } from '../../hooks/useEmployeeDirectory';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import type { OrgDepartmentNode } from '../../types/organization';
import { DepartmentTreeSelect } from './DepartmentTreeSelect';
import { formatTimesheetModeText } from './timesheetModeLabels';

export interface ISelectedEmployee {
  full_name: string;
  department: string | null;
}

export const EMPLOYEE_SELECTION_LIMIT = 500;
const PAGE_SIZE = 50;

interface IProps {
  deptTree: OrgDepartmentNode[];
  initialDepartmentId: string;
  selected: Map<number, ISelectedEmployee>;
  onToggle: (id: number, employee: ISelectedEmployee) => void;
  /** Режимы видимых и выбранных строк (грузит окно). */
  modeById: Map<number, ITimesheetModeEmployee>;
  modesLoading: boolean;
  /** Окну нужны id текущей выдачи, чтобы запросить для них режимы. */
  onVisibleIdsChange: (ids: number[]) => void;
}

const sourceText = (row: ITimesheetModeEmployee, department: string | null): string => {
  if (row.source === 'employee_explicit') return 'личный';
  if (row.source === 'legacy_default') return 'по умолчанию';
  const name = department ? `«${department}»` : '';
  return row.source === 'legacy_department'
    ? `от отдела ${name} (по назначению офисов)`.replace('  ', ' ')
    : `от отдела ${name}`.trim();
};

/** Левая колонка вкладки «Сотрудники»: поиск на сервере, выбор переживает поиск и листание. */
export const TimesheetModeEmployeesList: FC<IProps> = ({
  deptTree,
  initialDepartmentId,
  selected,
  onToggle,
  modeById,
  modesLoading,
  onVisibleIdsChange,
}) => {
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [page, setPage] = useState(1);
  const [showSelected, setShowSelected] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);

  const employeesQuery = usePaginatedEmployeesQuery({
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch || undefined,
    departmentId: departmentId || undefined,
    status: 'active',
    view: 'staff',
  });
  const pageRows = useMemo(() => employeesQuery.data?.data ?? [], [employeesQuery.data]);
  const totalPages = employeesQuery.data?.meta.totalPages ?? 0;

  const rows = useMemo(() => (
    showSelected
      ? [...selected.entries()]
        .map(([id, emp]) => ({ id, full_name: emp.full_name, department: emp.department }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
      : pageRows.map(emp => ({ id: emp.id, full_name: emp.full_name, department: emp.department }))
  ), [showSelected, selected, pageRows]);

  const visibleIdsKey = pageRows.map(emp => emp.id).join(',');
  useEffect(() => {
    onVisibleIdsChange(visibleIdsKey ? visibleIdsKey.split(',').map(Number) : []);
  }, [visibleIdsKey, onVisibleIdsChange]);

  // «Не на экране» — выбранные, которых нет в текущей выдаче: скрыты поиском,
  // фильтром отдела или лежат на другой странице.
  const offScreen = useMemo(() => {
    const onScreen = new Set(pageRows.map(emp => emp.id));
    let count = 0;
    for (const id of selected.keys()) if (!onScreen.has(id)) count++;
    return count;
  }, [pageRows, selected]);

  const changeSearch = (value: string): void => { setSearch(value); setPage(1); };
  const changeDepartment = (value: string): void => { setDepartmentId(value); setPage(1); };

  return (
    <>
      <div className="sc-obj-col-label">
        Сотрудники{selected.size > 0 ? ` — выбрано ${selected.size}` : ''}
        {offScreen > 0 && !showSelected ? `, не на экране ${offScreen}` : ''}
        {selected.size > 0 && (
          <button type="button" className="sc-link-btn" onClick={() => setShowSelected(prev => !prev)}>
            {showSelected ? 'к поиску' : 'показать выбранных'}
          </button>
        )}
      </div>
      {!showSelected && (
        <div className="sc-mode-employee-filters">
          <input
            type="text"
            className="sc-obj-search"
            value={search}
            onChange={e => changeSearch(e.target.value)}
            placeholder="Поиск по ФИО…"
          />
          <DepartmentTreeSelect departments={deptTree} value={departmentId} onChange={changeDepartment} />
        </div>
      )}
      {employeesQuery.isPending && !showSelected ? (
        <div className="sc-obj-empty">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="sc-obj-empty">— никого не найдено —</div>
      ) : (
        <div className="sc-obj-list">
          {rows.map(emp => {
            const row = modeById.get(emp.id);
            const isOn = selected.has(emp.id);
            const cannotEdit = row?.can_edit === false;
            const limitReached = !isOn && selected.size >= EMPLOYEE_SELECTION_LIMIT;
            return (
              <label
                key={emp.id}
                className={`sc-obj-item sc-mode-row ${isOn ? 'sc-obj-item--on' : ''} ${cannotEdit ? 'sc-mode-row--locked' : ''}`}
                title={cannotEdit ? 'Нет права менять режим этого сотрудника' : limitReached ? `Максимум ${EMPLOYEE_SELECTION_LIMIT} за раз` : undefined}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={(cannotEdit && !isOn) || limitReached}
                  onChange={() => onToggle(emp.id, { full_name: emp.full_name, department: emp.department })}
                />
                <span className="sc-mode-row-body">
                  <span className="sc-mode-row-head">
                    <span className="sc-mode-row-name">{emp.full_name}</span>
                    <span className="sc-mode-row-count">{emp.department || '—'}</span>
                  </span>
                  {row ? (
                    <span className="sc-mode-row-current">
                      Сейчас: {formatTimesheetModeText(row.effective_mode, row.effective_object_name)}
                      <span className={`sc-mode-source${row.source === 'employee_explicit' ? ' sc-mode-source--explicit' : ''}`}>
                        {sourceText(row, emp.department)}
                      </span>
                      {row.effective_mode === 'object' && row.effective_object_is_active === false && (
                        <span className="sc-mode-inactive">объект неактивен</span>
                      )}
                    </span>
                  ) : modesLoading ? (
                    <span className="sc-mode-row-current"><span className="sc-skeleton" /></span>
                  ) : (
                    <span className="sc-mode-row-current sc-muted">Режим недоступен</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {!showSelected && totalPages > 1 && (
        <div className="sc-mode-pager">
          <button type="button" className="sc-btn cancel" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>←</button>
          <span>{page} / {totalPages}</span>
          <button type="button" className="sc-btn cancel" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>→</button>
        </div>
      )}
    </>
  );
};
