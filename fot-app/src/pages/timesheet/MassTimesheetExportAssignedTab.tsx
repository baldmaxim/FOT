import { type FC, useState, useMemo, useEffect } from 'react';
import { Download, Search, CheckSquare, Square, Mail, CheckCircle, XCircle } from 'lucide-react';
import { useAssignedEmployees } from '../../hooks/useAssignedEmployees';
import { useTimesheetApprovalReviewList } from '../../hooks/useTimesheetApprovalData';
import { timesheetService } from '../../services/timesheetService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { useToast } from '../../contexts/ToastContext';

type TimesheetGroupingMode = 'employees' | 'objects';
type TimesheetExportPresentation = 'hr' | 'manager';

const ASSIGNED_STORAGE_KEY = 'timesheet_export_assigned_employees_v1';

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const loadStoredAssignedIds = (): Set<number> => {
  try {
    const raw = localStorage.getItem(ASSIGNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is number => typeof value === 'number'));
  } catch {
    return new Set();
  }
};

const saveStoredAssignedIds = (ids: Set<number>): void => {
  try {
    localStorage.setItem(ASSIGNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // QuotaExceededError / SecurityError — игнорируем
  }
};

interface IMassTimesheetExportAssignedTabProps {
  year: number;
  month: number;
  rangeStart: string;
  rangeEnd: string;
  groupBy: TimesheetGroupingMode;
  exportAs1C: boolean;
}

export const MassTimesheetExportAssignedTab: FC<IMassTimesheetExportAssignedTabProps> = ({
  year,
  month,
  rangeStart,
  rangeEnd,
  groupBy,
  exportAs1C,
}) => {
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => loadStoredAssignedIds());
  const [exporting, setExporting] = useState(false);
  const [exportingApproved, setExportingApproved] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [presentation, setPresentation] = useState<TimesheetExportPresentation>('hr');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useAssignedEmployees();
  const employees = useMemo(() => data ?? [], [data]);
  const { data: approvedList } = useTimesheetApprovalReviewList('approved');
  const approvedDeptIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of approvedList ?? []) {
      if (item.start_date === rangeStart && item.end_date === rangeEnd) {
        ids.add(item.department_id);
      }
    }
    return ids;
  }, [approvedList, rangeStart, rangeEnd]);
  const isAssigneeApproved = (employee: { departments?: { id: string }[] }): boolean => {
    const ids = employee.departments ?? [];
    if (ids.length === 0) return false;
    return ids.every(d => approvedDeptIds.has(d.id));
  };
  const approvedSelectedIds = useMemo(() => {
    const result: number[] = [];
    for (const employee of employees) {
      if (checkedIds.has(employee.id) && isAssigneeApproved(employee)) {
        result.push(employee.id);
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, checkedIds, approvedDeptIds]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(employee =>
      employee.full_name.toLowerCase().includes(q),
    );
  }, [employees, searchQuery]);

  useEffect(() => {
    saveStoredAssignedIds(checkedIds);
  }, [checkedIds]);

  useEffect(() => {
    if (!data) return;
    const validIds = new Set(data.map(employee => employee.id));
    setCheckedIds(prev => {
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [data]);

  const toggleEmployee = (id: number) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const employee of filteredEmployees) next.add(employee.id);
    return next;
  });

  const deselectAll = () => setCheckedIds(prev => {
    const next = new Set(prev);
    for (const employee of filteredEmployees) next.delete(employee.id);
    return next;
  });

  const handleEmail = async () => {
    if (checkedIds.size === 0) return;
    setEmailing(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const result = await timesheetService.emailAssigned({
        month: monthStr,
        from: rangeStart,
        to: rangeEnd,
        group_by: groupBy,
        export_as_1c: exportAs1C,
        employee_ids: [...checkedIds],
      });
      if (result.sent > 0) {
        showToast('success', `Отправлено: ${result.sent}${result.skipped > 0 ? `, без email: ${result.skipped}` : ''}`);
      }
      if (result.failed > 0) {
        showToast('error', `Ошибок при отправке: ${result.failed}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setEmailing(false);
    }
  };

  const handleExport = async (presentationOverride: TimesheetExportPresentation) => {
    if (checkedIds.size === 0) return;
    setPresentation(presentationOverride);
    setExporting(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportAssigned({
        month: monthStr,
        from: rangeStart,
        to: rangeEnd,
        group_by: groupBy,
        presentation: presentationOverride,
        export_as_1c: exportAs1C,
        employee_ids: [...checkedIds],
      });
      const daysInMonth = new Date(year, month, 0).getDate();
      const startDay = Number.parseInt(rangeStart.slice(-2), 10);
      const endDay = Number.parseInt(rangeEnd.slice(-2), 10);
      const isFullMonth = startDay === 1 && endDay === daysInMonth;
      const segmentSuffix = isFullMonth ? '' : `_${startDay}-${endDay}`;
      const templateSuffix = exportAs1C ? '_1С' : '';
      const presentationSuffix = presentationOverride === 'manager' ? '_Руководитель' : '';
      const filename = `Назначенные${templateSuffix}_${MONTH_NAMES[month]}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Assigned export error:', err);
      setError('Ошибка экспорта назначенных. Попробуйте ещё раз.');
    } finally {
      setExporting(false);
    }
  };

  const handleExportApproved = async () => {
    if (approvedSelectedIds.length === 0) return;
    setExportingApproved(true);
    setError(null);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.exportAssigned({
        month: monthStr,
        from: rangeStart,
        to: rangeEnd,
        group_by: groupBy,
        presentation: 'hr',
        export_as_1c: exportAs1C,
        employee_ids: approvedSelectedIds,
      });
      const startDay = Number.parseInt(rangeStart.slice(-2), 10);
      const endDay = Number.parseInt(rangeEnd.slice(-2), 10);
      const templateSuffix = exportAs1C ? '_1С' : '';
      const filename = `Назначенные_утверждённые${templateSuffix}_${MONTH_NAMES[month]}_${year}_${startDay}-${endDay}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Assigned export approved error:', err);
      setError('Ошибка экспорта утверждённых. Попробуйте ещё раз.');
    } finally {
      setExportingApproved(false);
    }
  };

  return (
    <>
      <div className="mte-controls">
        <div className="mte-search-wrap">
          <Search size={16} className="mte-search-icon" />
          <input
            className="mte-search"
            placeholder="Поиск по ФИО..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="mte-bulk-actions">
          <button className="mte-link-btn" onClick={selectAll}>Выбрать всех</button>
          <button className="mte-link-btn" onClick={deselectAll}>Снять все</button>
          <span className="mte-selected-count">Выбрано {checkedIds.size}</span>
        </div>
      </div>

      <div className="mte-tree-container">
        {isLoading ? (
          <div className="mte-loading">Загрузка назначенных сотрудников...</div>
        ) : isError ? (
          <div className="mte-error">Не удалось загрузить список назначенных</div>
        ) : filteredEmployees.length === 0 ? (
          <div className="mte-empty">
            {employees.length === 0 ? 'Назначенных сотрудников нет' : 'Никого не найдено'}
          </div>
        ) : (
          filteredEmployees.map(employee => {
            const isChecked = checkedIds.has(employee.id);
            const CheckIcon = isChecked ? CheckSquare : Square;
            const approved = isAssigneeApproved(employee);
            return (
              <div
                key={employee.id}
                className={`mte-tree-row mte-assigned-row ${isChecked ? 'mte-tree-row--checked' : ''}`}
              >
                <span className="mte-tree-expand mte-tree-expand--placeholder" />
                <button className="mte-tree-check" onClick={() => toggleEmployee(employee.id)}>
                  <CheckIcon size={18} className={isChecked ? 'mte-check-active' : 'mte-check-inactive'} />
                </button>
                <span className="mte-tree-name" onClick={() => toggleEmployee(employee.id)}>
                  {formatTimesheetEmployeeName(employee.full_name)}
                  {approved && (
                    <span className="mte-approved-icon" title="Все табели участка утверждены">
                      <CheckCircle size={14} />
                    </span>
                  )}
                </span>
                <span className="mte-assigned-badge">
                  {employee.department_count > 0 && `${employee.department_count} бр./отд.`}
                  {employee.department_count > 0 && employee.direct_employee_count > 0 && ' + '}
                  {employee.direct_employee_count > 0 && `${employee.direct_employee_count} сотр.`}
                </span>
                <span
                  className={`mte-email-indicator ${employee.email ? 'mte-email-indicator--ok' : 'mte-email-indicator--missing'}`}
                  title={employee.email ?? 'Email не указан'}
                >
                  {employee.email
                    ? <CheckCircle size={14} />
                    : <XCircle size={14} />}
                </span>
              </div>
            );
          })
        )}
      </div>

      {exporting && (
        <div className="mte-progress">
          <div className="mte-spinner" />
          <span>Генерация табелей ({checkedIds.size} сотр.)... Это может занять некоторое время</span>
        </div>
      )}

      {error && <div className="mte-error">{error}</div>}

      <div className="mte-footer">
        <button
          className={`mte-export-btn ${presentation === 'hr' ? 'mte-export-btn--active' : ''}`}
          onClick={() => handleExport('hr')}
          disabled={exporting || exportingApproved || emailing || checkedIds.size === 0}
        >
          <Download size={16} />
          {exporting && presentation === 'hr'
            ? (exportAs1C ? 'Экспорт...' : 'Выгрузить Факт...')
            : (exportAs1C ? `Экспорт (${checkedIds.size})` : `Выгрузить Факт (${checkedIds.size})`)}
        </button>
        {!exportAs1C && (
          <>
            <button
              className={`mte-export-btn mte-export-btn--secondary ${presentation === 'manager' ? 'mte-export-btn--active' : ''}`}
              onClick={() => handleExport('manager')}
              disabled={exporting || exportingApproved || emailing || checkedIds.size === 0}
            >
              <Download size={16} />
              {exporting && presentation === 'manager'
                ? 'Выгрузить урезанный...'
                : `Выгрузить урезанный (${checkedIds.size})`}
            </button>
            <button
              className="mte-export-btn mte-export-btn--approved"
              onClick={handleExportApproved}
              disabled={exporting || exportingApproved || emailing || approvedSelectedIds.length === 0}
              title={approvedSelectedIds.length === 0 ? 'Среди выбранных нет участков с полностью утверждёнными табелями за этот период' : undefined}
            >
              <CheckCircle size={16} />
              {exportingApproved
                ? 'Экспорт утверждённых...'
                : `Экспорт утверждённых (${approvedSelectedIds.length})`}
            </button>
            <button
              className="mte-export-btn mte-export-btn--email"
              onClick={handleEmail}
              disabled={exporting || exportingApproved || emailing || checkedIds.size === 0}
            >
              <Mail size={16} />
              {emailing ? 'Отправка...' : `Отправить на почту (${checkedIds.size})`}
            </button>
          </>
        )}
      </div>
    </>
  );
};
