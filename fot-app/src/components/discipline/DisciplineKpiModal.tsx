/**
 * Модалка KPI-сводки дисциплины: по одному сотруднику (поиск по ФИО) или по
 * отделу (поиск по названию). Блоки метрик включаются чек-боксами. Результат —
 * карточка со светофором + выгрузка в Excel. Период берётся со страницы.
 */
import { useMemo, useState, type FC } from 'react';
import { skudService } from '../../services/skudService';
import type {
  IDisciplineKpiResult,
  IDisciplineKpiRow,
  IKpiLeaveCase,
  KpiMetric,
  KpiSeverity,
} from '../../services/skudService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { triggerBlobDownload } from '../../utils/download';
import styles from './DisciplineKpiModal.module.css';

interface IKpiEmployee {
  id: number;
  name: string;
  departmentId: string | null;
  department: string;
}

interface IKpiDepartment {
  id: string;
  name: string;
}

interface IDisciplineKpiModalProps {
  employees: IKpiEmployee[];
  departments: IKpiDepartment[];
  startMonth: string;
  endMonth: string;
  periodLabel: string;
  onClose: () => void;
}

const METRIC_OPTIONS: { key: KpiMetric; label: string }[] = [
  { key: 'attendance', label: 'График / СКУД' },
  { key: 'sick', label: 'Больничные' },
  { key: 'unpaid', label: 'За свой счёт' },
];

const SEVERITY_LABEL: Record<KpiSeverity, string> = {
  green: 'Норма',
  yellow: 'Внимание',
  red: 'Риск',
};

const formatMinutes = (minutes: number): string => {
  if (!minutes || minutes <= 0) return '0м';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}ч ${m}м`;
  if (h > 0) return `${h}ч`;
  return `${m}м`;
};

const formatHours = (hours: number): string => {
  if (!hours || hours <= 0) return '0ч';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
};

const formatDayShort = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

const formatCase = (c: IKpiLeaveCase): string => {
  const range = c.startDate === c.endDate ? formatDayShort(c.startDate) : `${formatDayShort(c.startDate)}–${formatDayShort(c.endDate)}`;
  const flags: string[] = [];
  if (c.isShort) flags.push('короткий');
  if (c.isMonFri) flags.push('Пн/Пт');
  if (c.isAfterHoliday) flags.push('после праздника');
  if (c.retroactive) flags.push('задним числом');
  return `${range} · ${c.days} дн.${flags.length ? ` (${flags.join(', ')})` : ''}`;
};

export const DisciplineKpiModal: FC<IDisciplineKpiModalProps> = ({
  employees,
  departments,
  startMonth,
  endMonth,
  periodLabel,
  onClose,
}) => {
  const overlayHandlers = useOverlayDismiss(onClose);

  const [scope, setScope] = useState<'employee' | 'department'>('employee');
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<IKpiEmployee | null>(null);
  const [departmentQuery, setDepartmentQuery] = useState('');
  const [selectedDepartment, setSelectedDepartment] = useState<IKpiDepartment | null>(null);
  const [metrics, setMetrics] = useState<Set<KpiMetric>>(new Set<KpiMetric>(['attendance', 'sick', 'unpaid']));
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IDisciplineKpiResult | null>(null);

  const employeeMatches = useMemo(() => {
    const q = employeeQuery.trim().toLowerCase();
    if (!q) return [];
    return employees.filter(e => e.name.toLowerCase().includes(q)).slice(0, 40);
  }, [employeeQuery, employees]);

  const departmentMatches = useMemo(() => {
    const q = departmentQuery.trim().toLowerCase();
    if (!q) return [];
    return departments.filter(d => d.name.toLowerCase().includes(q)).slice(0, 40);
  }, [departmentQuery, departments]);

  const toggleMetric = (key: KpiMetric): void => {
    setMetrics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setResult(null);
  };

  const canCollect = metrics.size > 0 && (scope === 'employee' ? !!selectedEmployee : !!selectedDepartment);

  const buildParams = () => ({
    scope,
    employeeId: scope === 'employee' ? selectedEmployee?.id : undefined,
    departmentId: scope === 'department' ? selectedDepartment?.id : undefined,
    startMonth,
    endMonth,
    metrics: [...metrics],
  });

  const handleCollect = async (): Promise<void> => {
    if (!canCollect) return;
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getDisciplineKpi(buildParams());
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось собрать KPI');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    if (!canCollect) return;
    setExporting(true);
    try {
      const { blob, filename } = await skudService.exportDisciplineKpi(buildParams());
      triggerBlobDownload(blob, filename);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось выгрузить Excel');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.overlay} {...overlayHandlers}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <h2 className={styles.title}>KPI дисциплины</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">&times;</button>
        </div>

        <div className={styles.body}>
          <div className={styles.scopeToggle} role="tablist">
            <button
              type="button"
              className={`${styles.scopeBtn} ${scope === 'employee' ? styles.scopeBtnActive : ''}`}
              onClick={() => { setScope('employee'); setResult(null); }}
            >
              Сотрудник
            </button>
            <button
              type="button"
              className={`${styles.scopeBtn} ${scope === 'department' ? styles.scopeBtnActive : ''}`}
              onClick={() => { setScope('department'); setResult(null); }}
            >
              Отдел
            </button>
          </div>

          {scope === 'employee' ? (
            <div className={styles.field}>
              <label className={styles.label}>Сотрудник</label>
              {selectedEmployee ? (
                <div className={styles.chip}>
                  <span>{selectedEmployee.name}<small>{selectedEmployee.department}</small></span>
                  <button type="button" onClick={() => { setSelectedEmployee(null); setResult(null); }} aria-label="Сбросить">&times;</button>
                </div>
              ) : (
                <div className={styles.picker}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Поиск по ФИО…"
                    value={employeeQuery}
                    onChange={e => setEmployeeQuery(e.target.value)}
                    autoFocus
                  />
                  {employeeMatches.length > 0 && (
                    <ul className={styles.dropdown}>
                      {employeeMatches.map(emp => (
                        <li key={emp.id}>
                          <button type="button" onClick={() => { setSelectedEmployee(emp); setEmployeeQuery(''); setResult(null); }}>
                            {emp.name}<small>{emp.department}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.label}>Отдел</label>
              {selectedDepartment ? (
                <div className={styles.chip}>
                  <span>{selectedDepartment.name}</span>
                  <button type="button" onClick={() => { setSelectedDepartment(null); setResult(null); }} aria-label="Сбросить">&times;</button>
                </div>
              ) : (
                <div className={styles.picker}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Поиск по отделу…"
                    value={departmentQuery}
                    onChange={e => setDepartmentQuery(e.target.value)}
                    autoFocus
                  />
                  {departmentMatches.length > 0 && (
                    <ul className={styles.dropdown}>
                      {departmentMatches.map(dep => (
                        <li key={dep.id}>
                          <button type="button" onClick={() => { setSelectedDepartment(dep); setDepartmentQuery(''); setResult(null); }}>
                            {dep.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Метрики</label>
            <div className={styles.metrics}>
              {METRIC_OPTIONS.map(opt => (
                <label key={opt.key} className={styles.metric}>
                  <input type="checkbox" checked={metrics.has(opt.key)} onChange={() => toggleMetric(opt.key)} />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div className={styles.periodNote}>Период: {periodLabel}</div>

          <button type="button" className={styles.collectBtn} onClick={() => { void handleCollect(); }} disabled={!canCollect || loading}>
            {loading ? 'Сбор…' : 'Собрать'}
          </button>

          {error && <div className={styles.error}>{error}</div>}

          {result && <KpiResultCard result={result} onExport={() => { void handleExport(); }} exporting={exporting} />}
        </div>
      </div>
    </div>
  );
};

const KpiResultCard: FC<{ result: IDisciplineKpiResult; onExport: () => void; exporting: boolean }> = ({ result, onExport, exporting }) => {
  const { totals } = result;
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardSubject}>{result.subject || '—'}</div>
          {result.scope === 'department' && <div className={styles.cardMeta}>Сотрудников: {totals.employeeCount}</div>}
        </div>
        <span className={`${styles.badge} ${styles[`badge_${result.overallSeverity}`]}`}>{SEVERITY_LABEL[result.overallSeverity]}</span>
      </div>

      {totals.attendance && (
        <section className={styles.block}>
          <h4>График / СКУД</h4>
          <div className={styles.statGrid}>
            <Stat label="Опозданий" value={totals.attendance.lateCount} />
            <Stat label="Сумма опозданий" value={formatMinutes(totals.attendance.lateMinutes)} />
            <Stat label="Ранних уходов" value={totals.attendance.earlyCount} />
            <Stat label="Недоработок" value={totals.attendance.underworkCount} />
            <Stat label="Отсутствий" value={totals.attendance.absenceCount} />
            <Stat label="Отработано" value={formatHours(totals.attendance.workedHours)} />
            <Stat label="По графику" value={formatHours(totals.attendance.normHours)} />
          </div>
        </section>
      )}

      {totals.sick && (
        <section className={styles.block}>
          <h4>Больничные</h4>
          <div className={styles.statGrid}>
            <Stat label="Случаев" value={totals.sick.caseCount} />
            <Stat label="Дней всего" value={totals.sick.totalDays} />
            <Stat label="Коротких (3–5)" value={totals.sick.shortCaseCount} />
            <Stat label="Пн/Пт" value={totals.sick.monFriCount} />
            <Stat label="После праздника" value={totals.sick.afterHolidayCount} />
            <Stat label="Работал больным" value={totals.sick.workedSickDays} />
          </div>
          {totals.pending.sickDays > 0 && <div className={styles.pending}>На согласовании: {totals.pending.sickDays} дн.</div>}
        </section>
      )}

      {totals.unpaid && (
        <section className={styles.block}>
          <h4>За свой счёт</h4>
          <div className={styles.statGrid}>
            <Stat label="Случаев" value={totals.unpaid.caseCount} />
            <Stat label="Дней всего" value={totals.unpaid.totalDays} />
            <Stat label="Задним числом" value={totals.unpaid.retroactiveCaseCount} />
            {result.scope === 'employee'
              ? <Stat label="За год" value={`${result.rows[0]?.unpaid?.daysThisYear ?? 0}${result.rows[0]?.unpaid?.overLimit ? ' ⚠' : ''}`} />
              : <Stat label="Превысили лимит" value={totals.unpaid.overLimitEmployees} />}
          </div>
          {totals.pending.unpaidDays > 0 && <div className={styles.pending}>На согласовании: {totals.pending.unpaidDays} дн.</div>}
        </section>
      )}

      {result.scope === 'employee' && <EmployeeCases row={result.rows[0]} />}

      {result.scope === 'department' && result.rows.length > 0 && (
        <section className={styles.block}>
          <h4>Сотрудники с отметками ({result.rows.length})</h4>
          <ul className={styles.peopleList}>
            {result.rows.slice(0, 30).map(row => (
              <li key={row.employeeId}>
                <span className={`${styles.dot} ${styles[`badge_${row.severity}`]}`} />
                <span className={styles.peopleName}>{row.name}</span>
                <span className={styles.peopleMeta}>
                  {row.attendance && row.attendance.lateCount > 0 && `опозд. ${row.attendance.lateCount} `}
                  {row.sick && row.sick.totalDays > 0 && `больн. ${row.sick.totalDays}д `}
                  {row.unpaid && row.unpaid.totalDays > 0 && `за свой счёт ${row.unpaid.totalDays}д`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button type="button" className={styles.exportBtn} onClick={onExport} disabled={exporting}>
        {exporting ? 'Выгрузка…' : 'Экспорт в Excel'}
      </button>
    </div>
  );
};

const EmployeeCases: FC<{ row: IDisciplineKpiRow | undefined }> = ({ row }) => {
  if (!row) return null;
  const sickCases = row.sick?.cases ?? [];
  const unpaidCases = row.unpaid?.cases ?? [];
  if (sickCases.length === 0 && unpaidCases.length === 0) return null;
  return (
    <section className={styles.block}>
      <h4>Случаи</h4>
      {sickCases.length > 0 && (
        <div className={styles.caseGroup}>
          <span className={styles.caseLabel}>Больничные:</span>
          <ul>{sickCases.map((c, i) => <li key={`s${i}`}>{formatCase(c)}</li>)}</ul>
        </div>
      )}
      {unpaidCases.length > 0 && (
        <div className={styles.caseGroup}>
          <span className={styles.caseLabel}>За свой счёт:</span>
          <ul>{unpaidCases.map((c, i) => <li key={`u${i}`}>{formatCase(c)}</li>)}</ul>
        </div>
      )}
    </section>
  );
};

const Stat: FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className={styles.stat}>
    <span className={styles.statValue}>{value}</span>
    <span className={styles.statLabel}>{label}</span>
  </div>
);
