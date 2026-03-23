import { useState, useEffect, useMemo, useCallback, type FC } from 'react';
import { skudService } from '../services/skudService';
import { useIsMobile } from '../hooks/useIsMobile';
import '../styles/DisciplineAnalyticsPage.css';

type ViolationType = 'late' | 'underwork' | 'early' | 'absence';

interface IViolationRaw {
  employee_id: number;
  date: string;
  type: ViolationType;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
}

interface IViolationMapped extends IViolationRaw {
  dateFormatted: string;
  typeLabel: string;
  summary: string;
}

interface IEmployeeSummary {
  employee_id: number;
  name: string;
  position: string;
  department: string;
  departmentId: string | null;
  initials: string;
  late: number;
  underwork: number;
  early: number;
  absence: number;
  total: number;
  violations: IViolationMapped[];
}

const TYPE_LABELS: Record<ViolationType, string> = {
  late: 'Опоздание', underwork: 'Недоработка', early: 'Ранний уход', absence: 'Отсутствие >3ч',
};

const TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'late', label: 'Опоздания' },
  { key: 'underwork', label: 'Недоработки' },
  { key: 'early', label: 'Ранние уходы' },
  { key: 'absence', label: 'Отсутствия >3ч' },
];

const TYPE_COLORS: Record<ViolationType, string> = {
  late: 'var(--warning)', underwork: '#8b5cf6', early: 'var(--primary)', absence: 'var(--error)',
};
const TYPE_BG: Record<ViolationType, string> = {
  late: 'var(--warning-muted)', underwork: 'rgba(139, 92, 246, 0.1)', early: 'var(--primary-light)', absence: 'var(--error-muted)',
};

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const getInitials = (name: string) => {
  const parts = name.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const formatTime = (t: string | null) => t ? t.slice(0, 5) : '—';

const formatHours = (h: number | null) => {
  if (h === null) return '—';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}ч ${mins}м` : `${hrs}ч`;
};

/** Пересчёт deviation: если бэк вернул "+585 мин" → "+9ч 45м" */
const fixDeviation = (dev: string): string => {
  const match = dev.match(/^([+-]?)(\d+)\s*мин$/);
  if (!match) return dev;
  const sign = match[1];
  const totalMin = parseInt(match[2], 10);
  if (totalMin < 60) return dev;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m > 0) return `${sign}${h}ч ${m}м`;
  return `${sign}${h}ч`;
};

/** Единая строка описания нарушения (без дублирования) */
const getSummary = (v: IViolationRaw): string => {
  const entry = formatTime(v.first_entry);
  const exit = formatTime(v.last_exit);
  const worked = formatHours(v.total_hours);
  const dev = fixDeviation(v.deviation);

  switch (v.type) {
    case 'late':
      return `Приход\u00A0${entry}, опоздание\u00A0${dev}`;
    case 'underwork':
      return `${entry}\u00A0→\u00A0${exit}, отработано\u00A0${worked}\u00A0(${dev})`;
    case 'early': {
      // dev может быть "-1ч 30м" или старый формат "Уход HH:MM, норма HH:MM"
      const earlyDev = dev.startsWith('Уход') ? dev : `ушёл на\u00A0${dev.replace('-', '')} раньше`;
      return `${entry}\u00A0→\u00A0${exit}, ${earlyDev}`;
    }
    case 'absence':
      return `${entry}\u00A0→\u00A0${exit}, отсутствие\u00A0${dev.replace('Отсутствие ', '')}`;
  }
};

export const DisciplineAnalyticsPage: FC = () => {
  const isMobile = useIsMobile(430);

  const now = new Date();
  const currentYear = now.getFullYear();
  const initialMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [startMonth, setStartMonth] = useState(initialMonth);
  const [endMonth, setEndMonth] = useState(initialMonth);
  const [rawViolations, setRawViolations] = useState<IViolationMapped[]>([]);
  const [empData, setEmpData] = useState<Record<number, { full_name: string; position: string | null; department_id: string | null }>>({});
  const [deptData, setDeptData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [panelEmpId, setPanelEmpId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('');

  const normalizedPeriod = useMemo(() => {
    if (startMonth <= endMonth) return { startMonth, endMonth };
    return { startMonth: endMonth, endMonth: startMonth };
  }, [startMonth, endMonth]);

  const formatMonthLabel = useCallback((value: string) => {
    const [y, m] = value.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }, []);

  const monthLabel = useMemo(() => {
    if (normalizedPeriod.startMonth === normalizedPeriod.endMonth) {
      return formatMonthLabel(normalizedPeriod.startMonth);
    }
    return `${formatMonthLabel(normalizedPeriod.startMonth)} - ${formatMonthLabel(normalizedPeriod.endMonth)}`;
  }, [formatMonthLabel, normalizedPeriod]);

  const yearOptions = useMemo(() => {
    const selectedYears = [startMonth, endMonth].map(value => Number(value.slice(0, 4)));
    const minYear = Math.min(currentYear, ...selectedYears) - 2;
    const maxYear = Math.max(currentYear, ...selectedYears) + 2;
    return Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index);
  }, [currentYear, endMonth, startMonth]);

  const getMonthParts = useCallback((value: string) => {
    const [year, month] = value.split('-').map(Number);
    return { year, month };
  }, []);

  const buildMonthValue = useCallback((year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`, []);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getDisciplineViolations(normalizedPeriod, signal);
      if (signal?.aborted) return;
      setEmpData(data.employees);
      setDeptData(data.departments);
      setRawViolations(data.violations.map(v => {
        const fixed = { ...v, deviation: fixDeviation(v.deviation) };
        return {
          ...fixed,
          dateFormatted: formatDate(v.date),
          typeLabel: TYPE_LABELS[v.type],
          summary: getSummary(fixed),
        };
      }));
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      if (signal?.aborted) return;
      setLoading(false);
    }
  }, [normalizedPeriod]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // Список отделов для фильтра
  const departmentOptions = useMemo(() => {
    const depts = new Map<string, string>();
    for (const emp of Object.values(empData)) {
      if (emp.department_id && deptData[emp.department_id]) {
        depts.set(emp.department_id, deptData[emp.department_id]);
      }
    }
    return [...depts.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [empData, deptData]);

  // Агрегация: группировка по сотрудникам
  const employees = useMemo<IEmployeeSummary[]>(() => {
    const map: Record<number, IEmployeeSummary> = {};
    for (const v of rawViolations) {
      if (!map[v.employee_id]) {
        const emp = empData[v.employee_id] || { full_name: `#${v.employee_id}`, position: null, department_id: null };
        const dept = emp.department_id ? (deptData[emp.department_id] || '—') : '—';
        map[v.employee_id] = {
          employee_id: v.employee_id,
          name: emp.full_name,
          position: emp.position || '—',
          department: dept,
          departmentId: emp.department_id,
          initials: getInitials(emp.full_name),
          late: 0, underwork: 0, early: 0, absence: 0, total: 0,
          violations: [],
        };
      }
      map[v.employee_id][v.type]++;
      map[v.employee_id].total++;
      map[v.employee_id].violations.push(v);
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [rawViolations, empData, deptData]);

  // Фильтрация по отделу + поиску + табу
  const filtered = useMemo(() => {
    let list = employees;

    // Фильтр по отделу
    if (selectedDept) {
      list = list.filter(e => e.departmentId === selectedDept);
    }

    // Поиск по ФИО
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(e => e.name.toLowerCase().includes(q));
    }

    // Фильтр по табу
    if (activeTab !== 'all') {
      const key = activeTab as ViolationType;
      list = list.filter(e => e[key] > 0).sort((a, b) => b[key] - a[key]);
    }

    return list;
  }, [employees, activeTab, selectedDept, searchQuery]);

  // Счётчики уникальных людей (после фильтров отдела и поиска)
  const peopleCounts = useMemo(() => {
    let base = employees;
    if (selectedDept) base = base.filter(e => e.departmentId === selectedDept);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      base = base.filter(e => e.name.toLowerCase().includes(q));
    }
    const c: Record<string, number> = { all: base.length, late: 0, underwork: 0, early: 0, absence: 0 };
    for (const e of base) {
      if (e.late > 0) c.late++;
      if (e.underwork > 0) c.underwork++;
      if (e.early > 0) c.early++;
      if (e.absence > 0) c.absence++;
    }
    return c;
  }, [employees, selectedDept, searchQuery]);

  const panelEmployee = panelEmpId !== null ? employees.find(e => e.employee_id === panelEmpId) : null;

  const hasFilters = selectedDept !== '' || searchQuery !== '';

  const clearFilters = () => {
    setSelectedDept('');
    setSearchQuery('');
  };

  const exportToExcel = async () => {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const source = filtered.length > 0 ? filtered : employees;

    const thinBorder: any = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };
    const detailStyles: Record<string, { font: string; bg: string }> = {
      late: { font: 'FFDC2626', bg: 'FFFFF7ED' },
      underwork: { font: 'FF7C3AED', bg: 'FFF5F3FF' },
      early: { font: 'FF2563EB', bg: 'FFEFF6FF' },
      absence: { font: 'FFDC2626', bg: 'FFFEF2F2' },
    };

    const buildRating = (type: ViolationType, sheetName: string, countLabel: string) => {
      const ws = wb.addWorksheet(sheetName);
      ws.columns = [
        { header: '№', key: 'num', width: 5 },
        { header: 'ФИО', key: 'name', width: 35 },
        { header: 'Должность', key: 'position', width: 22 },
        { header: 'Отдел', key: 'department', width: 28 },
        { header: countLabel, key: 'count', width: 22 },
        { header: 'Детали', key: 'details', width: 60 },
      ];

      const headerRow = ws.getRow(1);
      headerRow.height = 28;
      for (let col = 1; col <= 6; col++) {
        const cell = headerRow.getCell(col);
        cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }

      const sorted = source.filter(e => e[type] > 0).sort((a, b) => b[type] - a[type]);
      const ds = detailStyles[type] || detailStyles.late;

      sorted.forEach((e, i) => {
        const details = e.violations
          .filter(v => v.type === type)
          .map(v => {
            const entry = v.first_entry ? v.first_entry.slice(0, 5) : '—';
            const exit = v.last_exit ? v.last_exit.slice(0, 5) : '—';
            if (type === 'late') {
              return `${v.dateFormatted} — приход в ${entry} (опоздание ${v.deviation.replace('+', '')})`;
            }
            if (type === 'early') {
              const dev = v.deviation.replace('-', '');
              const [eh, em] = (v.first_entry || '09:00').split(':').map(Number);
              const expMin = eh * 60 + em + 9 * 60;
              const expH = String(Math.floor(expMin / 60)).padStart(2, '0');
              const expM = String(expMin % 60).padStart(2, '0');
              return `${v.dateFormatted} — ${entry}→${exit}, норма ${expH}:${expM} (${dev} раньше)`;
            }
            if (type === 'absence') {
              const dev = v.deviation.replace('Отсутствие ', '');
              const worked = v.total_hours !== null ? `${Math.floor(v.total_hours)}ч ${Math.round((v.total_hours % 1) * 60)}м` : '—';
              return `${v.dateFormatted} — ${entry}→${exit}, присутствие ${worked} (отсутствие ${dev})`;
            }
            return `${v.dateFormatted} — ${entry}→${exit}, недоработка ${v.deviation}`;
          })
          .join('\n');

        const row = ws.addRow({ num: i + 1, name: e.name, position: e.position, department: e.department, count: e[type], details });
        row.getCell('num').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('name').alignment = { vertical: 'middle' };
        row.getCell('position').alignment = { vertical: 'middle', wrapText: true };
        row.getCell('department').alignment = { vertical: 'middle', wrapText: true };
        row.getCell('count').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('count').font = { bold: true, size: 11 };
        row.getCell('details').alignment = { vertical: 'top', wrapText: true };
        row.getCell('details').font = { bold: true, size: 10, color: { argb: ds.font } };
        row.getCell('details').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ds.bg } };

        if (i % 2 === 1) {
          ['num', 'name', 'position', 'department', 'count'].forEach(key => {
            const cell = row.getCell(key);
            if (!cell.fill || !(cell.fill as { fgColor?: unknown }).fgColor) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
            }
          });
        }
      });

      ws.eachRow(row => { row.eachCell(cell => { cell.border = thinBorder; }); });
    };

    buildRating('late', 'Рейтинг опозданий', 'Кол-во опозданий');
    buildRating('underwork', 'Рейтинг недоработок', 'Кол-во недоработок');
    buildRating('early', 'Рейтинг ранних уходов', 'Кол-во ранних уходов');
    buildRating('absence', 'Отсутствия более 3ч', 'Кол-во отсутствий');

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Аналитика_дисциплины_${monthLabel.replace(/\s+/g, '_')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="da-page">
      {/* Header: period picker + export */}
      <div className="da-header-row">
        <div className="da-period-control">
          <label className="da-month-field">
            <select
              className="da-period-select"
              value={getMonthParts(startMonth).month}
              onChange={e => {
                const m = Number(e.target.value);
                const y = getMonthParts(startMonth).year;
                const v = buildMonthValue(y, m);
                setStartMonth(v);
                if (v > endMonth) setEndMonth(v);
              }}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={`start-month-${index + 1}`} value={index + 1}>{name}</option>
              ))}
            </select>
            <select
              className="da-period-select da-period-select-year"
              value={getMonthParts(startMonth).year}
              onChange={e => {
                const y = Number(e.target.value);
                const m = getMonthParts(startMonth).month;
                const v = buildMonthValue(y, m);
                setStartMonth(v);
                if (v > endMonth) setEndMonth(v);
              }}
            >
              {yearOptions.map(year => (
                <option key={`start-year-${year}`} value={year}>{year}</option>
              ))}
            </select>
          </label>
          <span className="da-period-sep">—</span>
          <label className="da-month-field">
            <select
              className="da-period-select"
              value={getMonthParts(endMonth).month}
              onChange={e => {
                const m = Number(e.target.value);
                const y = getMonthParts(endMonth).year;
                const v = buildMonthValue(y, m);
                setEndMonth(v);
                if (v < startMonth) setStartMonth(v);
              }}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={`end-month-${index + 1}`} value={index + 1}>{name}</option>
              ))}
            </select>
            <select
              className="da-period-select da-period-select-year"
              value={getMonthParts(endMonth).year}
              onChange={e => {
                const y = Number(e.target.value);
                const m = getMonthParts(endMonth).month;
                const v = buildMonthValue(y, m);
                setEndMonth(v);
                if (v < startMonth) setStartMonth(v);
              }}
            >
              {yearOptions.map(year => (
                <option key={`end-year-${year}`} value={year}>{year}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="da-header-spacer" />
        <button className="da-btn da-btn-export" onClick={exportToExcel}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Экспорт в Excel
        </button>
      </div>

      {/* Stats — single compact bar */}
      <div className="da-stats-bar">
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--warning)' }} />
          <span className="da-stats-item-label">Опоздания</span>
          <span className="da-stats-item-value" style={{ color: 'var(--warning)' }}>{peopleCounts.late}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: '#8b5cf6' }} />
          <span className="da-stats-item-label">Недоработки</span>
          <span className="da-stats-item-value" style={{ color: '#8b5cf6' }}>{peopleCounts.underwork}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--primary)' }} />
          <span className="da-stats-item-label">Ранние уходы</span>
          <span className="da-stats-item-value" style={{ color: 'var(--primary)' }}>{peopleCounts.early}</span>
        </div>
        <div className="da-stats-divider" />
        <div className="da-stats-item">
          <span className="da-stats-dot" style={{ background: 'var(--error)' }} />
          <span className="da-stats-item-label">Отсутствия &gt;3ч</span>
          <span className="da-stats-item-value" style={{ color: 'var(--error)' }}>{peopleCounts.absence}</span>
        </div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Загрузка...</div>}
      {error && <div style={{ padding: 20, color: 'var(--error)' }}>{error}</div>}

      {!loading && !error && (
        <>
          {/* Tabs + filters in one row */}
          <div className="da-toolbar">
            <div className="da-tabs">
              {TABS.map(t => (
                <button key={t.key} className={`da-tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
                  {t.label}
                  <span className="da-tab-count">{peopleCounts[t.key]}</span>
                </button>
              ))}
            </div>
            <div className="da-filters">
              <div className="da-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="text"
                  placeholder="Поиск по ФИО..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="da-search-clear" onClick={() => setSearchQuery('')}>&times;</button>
                )}
              </div>
              <select
                className="da-dept-select"
                value={selectedDept}
                onChange={e => setSelectedDept(e.target.value)}
              >
                <option value="">Все отделы</option>
                {departmentOptions.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
              {hasFilters && (
                <button className="da-btn da-btn-reset" onClick={clearFilters}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  Сбросить
                </button>
              )}
            </div>
          </div>

          <div className="da-table-wrap">
            {filtered.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Нарушений не найдено</div>
            ) : isMobile ? (
              <div className="da-mobile-cards">
                {filtered.map(emp => (
                  <div key={emp.employee_id} className="da-mobile-card" onClick={() => setPanelEmpId(emp.employee_id)}>
                    <div className="da-mobile-card-header">
                      <div className="da-emp-avatar">{emp.initials}</div>
                      <div className="da-mobile-card-info">
                        <div className="da-emp-name">{emp.name}</div>
                        <div className="da-emp-meta">{emp.position}</div>
                      </div>
                      <div className="da-mobile-card-total">{emp.total}</div>
                    </div>
                    <div className="da-mobile-card-badges">
                      {emp.late > 0 && <CountBadge count={emp.late} type="late" />}
                      {emp.underwork > 0 && <CountBadge count={emp.underwork} type="underwork" />}
                      {emp.early > 0 && <CountBadge count={emp.early} type="early" />}
                      {emp.absence > 0 && <CountBadge count={emp.absence} type="absence" />}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <table className="da-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th style={{ textAlign: 'center' }}>Опоздания</th>
                    <th style={{ textAlign: 'center' }}>Недоработки</th>
                    <th style={{ textAlign: 'center' }}>Ранние уходы</th>
                    <th style={{ textAlign: 'center' }}>Отсутствия</th>
                    <th style={{ textAlign: 'center' }}>Всего</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(emp => (
                    <tr key={emp.employee_id} onClick={() => setPanelEmpId(emp.employee_id)}>
                      <td>
                        <div className="da-emp-cell">
                          <div className="da-emp-avatar">{emp.initials}</div>
                          <div>
                            <div className="da-emp-name">{emp.name}</div>
                            <div className="da-emp-meta">{emp.position} · {emp.department}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}><CountBadge count={emp.late} type="late" /></td>
                      <td style={{ textAlign: 'center' }}><CountBadge count={emp.underwork} type="underwork" /></td>
                      <td style={{ textAlign: 'center' }}><CountBadge count={emp.early} type="early" /></td>
                      <td style={{ textAlign: 'center' }}><CountBadge count={emp.absence} type="absence" /></td>
                      <td style={{ textAlign: 'center', fontWeight: 600, fontSize: 14 }}>{emp.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Backdrop */}
      {panelEmployee && <div className="da-backdrop" onClick={() => setPanelEmpId(null)} />}

      {/* Detail panel */}
      <div className={`da-panel ${panelEmployee ? 'open' : ''}`}>
        {panelEmployee && (
          <>
            <div className="da-panel-header">
              <span className="da-panel-title">Нарушения сотрудника</span>
              <button className="da-panel-close" onClick={() => setPanelEmpId(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="da-panel-body">
              <div className="da-panel-emp">
                <div className="da-panel-avatar">{panelEmployee.initials}</div>
                <div>
                  <div className="da-panel-emp-name">{panelEmployee.name}</div>
                  <div className="da-panel-emp-position">{panelEmployee.position}</div>
                  <div className="da-panel-emp-dept">{panelEmployee.department}</div>
                </div>
              </div>

              <div className="da-panel-summary">
                {panelEmployee.late > 0 && <span className="da-badge" style={{ background: TYPE_BG.late, color: TYPE_COLORS.late }}>Опоздания: {panelEmployee.late}</span>}
                {panelEmployee.underwork > 0 && <span className="da-badge" style={{ background: TYPE_BG.underwork, color: TYPE_COLORS.underwork }}>Недоработки: {panelEmployee.underwork}</span>}
                {panelEmployee.early > 0 && <span className="da-badge" style={{ background: TYPE_BG.early, color: TYPE_COLORS.early }}>Ранние уходы: {panelEmployee.early}</span>}
                {panelEmployee.absence > 0 && <span className="da-badge" style={{ background: TYPE_BG.absence, color: TYPE_COLORS.absence }}>Отсутствия: {panelEmployee.absence}</span>}
              </div>

              <div className="da-panel-section">
                <div className="da-panel-section-title">Нарушения за период ({panelEmployee.total})</div>
                {panelEmployee.violations.map((v, i) => (
                  <a
                    key={i}
                    className="da-violation-item da-violation-link"
                    href={`/tender/${panelEmployee.employee_id}?tab=skud&date=${v.date}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Открыть СКУД сотрудника за этот день"
                  >
                    <div className="da-violation-date">{v.dateFormatted}</div>
                    <span className="da-badge" style={{ background: TYPE_BG[v.type], color: TYPE_COLORS[v.type], fontSize: 11 }}>{v.typeLabel}</span>
                    <span className="da-violation-summary">{v.summary}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const CountBadge: FC<{ count: number; type: ViolationType }> = ({ count, type }) => {
  if (count === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>;
  return (
    <span className="da-count-badge" style={{ background: TYPE_BG[type], color: TYPE_COLORS[type] }}>
      {count}
    </span>
  );
};

