import { type FC, type ReactElement, useMemo, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  useMtsBusinessAccounts,
  useMtsBusinessAccountsSummary,
  useMtsBusinessReport,
} from '../../hooks/useMtsBusinessData';
import {
  useMtsBusinessBillingSummary,
  useMtsBusinessBillingTrend,
} from '../../hooks/useMtsBusinessBillingData';
import {
  useMtsBusinessEmployeesCatalog,
  useMtsBusinessAccountsPackages,
} from '../../hooks/useMtsBusinessCatalogData';
import { useMtsBusinessActions } from '../../hooks/useMtsBusinessActionsData';
import { useMtsBusinessRefreshAllStatus } from '../../hooks/useMtsBusinessRefreshAll';
import { useMtsBusinessSubscribers } from '../../hooks/useMtsBusinessSubscribers';
import type { IMtsSubscriberRow } from '../../services/mtsBusinessSubscribersService';
import type { MtsBusinessDailyMetric } from '../../services/mtsBusinessBillingService';
import { SubscriberDrawer } from './subscribers/SubscriberDrawer';
import { UnavailableNotice } from './common/UnavailableNotice';
import { toISODate, fmtDur, fmtLast, fmtMoney, fmtPackage, lastMonths, monthRange } from './mtsBusinessFormat';
import styles from './OverviewSection.module.css';

const ACCENT_PALETTE = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--purple)', 'var(--text-tertiary)'];

/** Максимум из двух ISO-меток (одинаковый формат — сравнение строк корректно). */
const maxIso = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : (a ?? b));

const Seg: FC<{ options: { v: string; label: string }[]; value: string; onChange: (v: string) => void }> = ({ options, value, onChange }) => (
  <div className={styles.segment}>
    {options.map(o => (
      <button
        key={o.v}
        className={`${styles.segBtn} ${value === o.v ? styles.segBtnActive : ''}`}
        onClick={() => onChange(o.v)}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const ChartTooltip: FC<{ active?: boolean; payload?: { value: number }[]; label?: string }> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(Math.round(payload[0].value))}</div>
    </div>
  );
};

/** Объединённая строка «Сотрудники»: время разговоров (период) + начисления/тариф/услуги. */
interface IEmployeeStatRow {
  key: string;
  employeeId: number | null;
  label: string;
  tabNumber: string | null;
  departmentName: string | null;
  calls: number;
  totalSeconds: number;
  chargesAmount: number | null;
  tariffName: string | null;
  servicesCount: number;
  servicesMonthlyTotal: number;
}

interface IOverviewSectionProps {
  /** Выбранный ЛС ('' — все); стейт живёт в MtsBusinessPage — им же пользуется кнопка «Обновить». */
  accountId: string;
  onAccountChange: (id: string) => void;
}

export const OverviewSection: FC<IOverviewSectionProps> = ({ accountId, onAccountChange }) => {
  const now = useMemo(() => new Date(), []);
  // Дефолт периода — текущий месяц (с 1-го числа по сегодня).
  const defaultCallsFrom = useMemo(
    () => toISODate(new Date(now.getFullYear(), now.getMonth(), 1)),
    [now],
  );
  const [callsFrom, setCallsFrom] = useState(defaultCallsFrom);
  const [callsTo, setCallsTo] = useState(toISODate(now));
  const months = useMemo(() => lastMonths(12, now), [now]);
  const selectedMonth = callsFrom.slice(0, 7);
  const onPickMonth = (ym: string): void => {
    const { from, to } = monthRange(ym, now);
    setCallsFrom(from);
    setCallsTo(to);
  };
  const [trendFrom, setTrendFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth() - 2, now.getDate())));
  const [trendTo, setTrendTo] = useState(toISODate(now));
  const [trendMetric, setTrendMetric] = useState<MtsBusinessDailyMetric>('balance');
  const [topMetric, setTopMetric] = useState<'time' | 'cost'>('time');
  const [showRestEmployees, setShowRestEmployees] = useState(false);
  const [empSearch, setEmpSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [drawerRow, setDrawerRow] = useState<IMtsSubscriberRow | null>(null);

  const accountsMeta = useMtsBusinessAccounts();
  const accSummary = useMtsBusinessAccountsSummary(callsFrom, callsTo, true, accountId || undefined);
  const report = useMtsBusinessReport(callsFrom, callsTo, true, accountId || undefined);
  const billingSummary = useMtsBusinessBillingSummary(callsFrom, callsTo, accountId || undefined);
  const trend = useMtsBusinessBillingTrend(trendMetric, trendFrom, trendTo, accountId || undefined);
  const employeesCatalog = useMtsBusinessEmployeesCatalog(accountId || undefined);
  const accountsPackages = useMtsBusinessAccountsPackages(accountId || undefined);
  const actions = useMtsBusinessActions(true);
  const refreshAllStatus = useMtsBusinessRefreshAllStatus();
  // Номера с привязками/отделами — источник фильтра по отделам и клика в карточку абонента.
  const subscribers = useMtsBusinessSubscribers(true);

  // Секция «не подключена в тарифе МТС», если в последнем прогоне «Обновить всё»
  // соответствующий шаг завершился unavailable (403/1010). Данные обзора идут из
  // истории БД, поэтому сама пустота ещё не означает отключённый продукт —
  // сверяемся с фактическим результатом последнего обращения к API.
  const stepUnavailable = (step: string): boolean =>
    (refreshAllStatus.data?.steps ?? []).some(st =>
      st.step === step
      && st.status === 'unavailable'
      && (!accountId || st.accountId === accountId));

  const accRows = accSummary.data ?? [];
  const totalCalls = accRows.reduce((a, r) => a + r.calls, 0);
  const totalSec = accRows.reduce((a, r) => a + r.totalSeconds, 0);
  const billingAccounts = billingSummary.data?.accounts ?? [];
  const billingEmployees = useMemo(() => billingSummary.data?.employees ?? [], [billingSummary.data]);
  const hasChargesData = billingEmployees.some(r => r.chargesAmount != null);
  const totalCharges = hasChargesData
    ? billingEmployees.reduce((a, r) => a + (r.chargesAmount ?? 0), 0)
    : null;
  const totalUnpaid = billingAccounts.reduce((a, r) => a + (r.unpaidAmount ?? 0), 0);
  const inProgressCount = (actions.data ?? []).filter(a => a.status === 'in_progress').length;

  const catalogByEmployee = useMemo(() => {
    const map = new Map<string, { tariffNames: Set<string>; servicesCount: number; servicesMonthlyTotal: number; maxCapturedAt: string | null }>();
    for (const c of employeesCatalog.data ?? []) {
      const key = c.employeeId != null ? String(c.employeeId) : `unmapped-${c.employeeFullName ?? ''}`;
      let g = map.get(key);
      if (!g) { g = { tariffNames: new Set(), servicesCount: 0, servicesMonthlyTotal: 0, maxCapturedAt: null }; map.set(key, g); }
      if (c.tariffName) g.tariffNames.add(c.tariffName);
      g.servicesCount += c.servicesCount;
      g.servicesMonthlyTotal += c.servicesMonthlyTotal;
      g.maxCapturedAt = maxIso(g.maxCapturedAt, c.capturedAt);
    }
    return map;
  }, [employeesCatalog.data]);

  // Номера каждого сотрудника (для открытия карточки абонента) и список отделов.
  const employeeNumbers = useMemo(() => {
    const m = new Map<number, IMtsSubscriberRow[]>();
    for (const r of subscribers.data ?? []) {
      if (r.employeeId == null || !r.msisdn) continue;
      const list = m.get(r.employeeId) ?? [];
      list.push(r);
      m.set(r.employeeId, list);
    }
    return m;
  }, [subscribers.data]);

  const departments = useMemo(
    () => [...new Set((subscribers.data ?? [])
      .filter(r => r.employeeId != null)
      .map(r => r.departmentName)
      .filter((d): d is string => !!d))].sort((a, b) => a.localeCompare(b, 'ru')),
    [subscribers.data],
  );

  // Объединение «Топ сотрудников» (время за период) и «По сотрудникам»
  // (начисления/тариф/услуги) в один список.
  const employeeStats = useMemo(() => {
    const map = new Map<string, IEmployeeStatRow>();
    const deptOf = (employeeId: number | null): string | null =>
      employeeId != null
        ? employeeNumbers.get(employeeId)?.find(r => r.departmentName)?.departmentName ?? null
        : null;
    const ensure = (employeeId: number | null, label: string | null, tab: string | null): IEmployeeStatRow => {
      const key = employeeId != null ? String(employeeId) : `unmapped-${label ?? ''}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          employeeId,
          label: label ?? 'Не привязанные номера',
          tabNumber: tab,
          departmentName: deptOf(employeeId),
          calls: 0,
          totalSeconds: 0,
          chargesAmount: null,
          tariffName: null,
          servicesCount: 0,
          servicesMonthlyTotal: 0,
        };
        map.set(key, row);
      }
      return row;
    };
    for (const r of report.data ?? []) {
      if (r.employeeId == null && r.calls === 0) continue;
      const row = ensure(r.employeeId, r.employeeFullName, r.employeeTabNumber);
      row.calls += r.calls;
      row.totalSeconds += r.totalSeconds;
    }
    for (const r of billingEmployees) {
      const row = ensure(r.employeeId, r.employeeFullName, r.employeeTabNumber);
      if (r.chargesAmount != null) row.chargesAmount = (row.chargesAmount ?? 0) + r.chargesAmount;
      const key = r.employeeId != null ? String(r.employeeId) : `unmapped-${r.employeeFullName ?? ''}`;
      const c = catalogByEmployee.get(key);
      if (c) {
        row.tariffName = [...c.tariffNames].join(', ') || null;
        row.servicesCount = c.servicesCount;
        row.servicesMonthlyTotal = c.servicesMonthlyTotal;
      }
    }
    return [...map.values()];
  }, [report.data, billingEmployees, catalogByEmployee, employeeNumbers]);

  const TOP_N = 10;
  const empQuery = empSearch.trim().toLowerCase();
  const metricValue = (r: IEmployeeStatRow): number => (topMetric === 'time' ? r.totalSeconds : r.chargesAmount ?? 0);
  const topItems = useMemo(() => {
    const filtered = employeeStats.filter(r => {
      if (deptFilter && r.departmentName !== deptFilter) return false;
      if (empQuery && !`${r.label} ${r.tabNumber ?? ''}`.toLowerCase().includes(empQuery)) return false;
      // Нулевые по выбранной метрике прячем, но при активном поиске показываем
      // всё найденное — секция заменяет и справочную таблицу «По сотрудникам».
      if (!empQuery && metricValue(r) <= 0) return false;
      return true;
    });
    return filtered.sort((a, b) => metricValue(b) - metricValue(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeStats, deptFilter, empQuery, topMetric]);
  // Поиск/фильтр отдела показывают весь результат сразу; без них — топ-10 + «Остальные».
  const collapsible = !empQuery && !deptFilter;
  const topTop = collapsible ? topItems.slice(0, TOP_N) : topItems;
  const topRest = collapsible ? topItems.slice(TOP_N) : [];
  const topMax = Math.max(1, ...topItems.map(metricValue));

  const openEmployeeDrawer = (employeeId: number | null): void => {
    if (employeeId == null) return;
    const numbers = employeeNumbers.get(employeeId);
    if (!numbers || numbers.length === 0) return;
    // Несколько номеров — открываем самый «разговорчивый».
    const best = [...numbers].sort((a, b) => b.totalSeconds - a.totalSeconds)[0];
    setDrawerRow(best);
  };

  const renderEmployeeRow = (r: IEmployeeStatRow, index: number): ReactElement => {
    const value = metricValue(r);
    const clickable = r.employeeId != null && (employeeNumbers.get(r.employeeId)?.length ?? 0) > 0;
    const sub = [
      r.tabNumber ? `таб. ${r.tabNumber}` : null,
      r.departmentName,
      r.calls > 0 ? `${r.calls} зв.` : null,
      r.servicesCount > 0 ? `${r.servicesCount} усл. · ${fmtMoney(r.servicesMonthlyTotal)}/мес` : null,
    ].filter(Boolean).join(' · ');
    const primary = topMetric === 'time' ? fmtDur(r.totalSeconds) : fmtMoney(r.chargesAmount ?? 0);
    const secondary = topMetric === 'time'
      ? (r.chargesAmount != null ? fmtMoney(r.chargesAmount) : '')
      : (r.totalSeconds > 0 ? fmtDur(r.totalSeconds) : '');
    return (
      <div
        key={r.key}
        className={`${styles.barRow} ${clickable ? styles.barRowClickable : ''}`}
        onClick={clickable ? () => openEmployeeDrawer(r.employeeId) : undefined}
        title={clickable ? 'Открыть карточку абонента' : undefined}
      >
        <span className={styles.barIndex}>{index + 1}</span>
        <div style={{ minWidth: 0 }}>
          <div className={styles.barLabel}>
            {r.label}
            {sub && <span className={styles.barSub}> · {sub}</span>}
            {r.tariffName && <span className={styles.barBadge}>{r.tariffName}</span>}
          </div>
          <div className={styles.barTrack}>
            <div className={styles.barFill} style={{ width: `${Math.round((value / topMax) * 100)}%` }} />
          </div>
        </div>
        <div className={styles.barValueBox}>
          <div className={styles.barValue}>{primary}</div>
          {secondary && <div className={styles.barValueSub}>{secondary}</div>}
        </div>
      </div>
    );
  };

  const accountsOverview = accRows.map(r => {
    const billing = billingAccounts.find(b => b.accountId === r.accountId);
    return { ...r, balance: billing?.balance ?? null, unpaidAmount: billing?.unpaidAmount ?? null };
  }).filter(r => r.accountId);
  const accountsOverviewTotal = accountsOverview.reduce((a, r) => a + r.totalSeconds, 0);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Seg
          value={accountId}
          onChange={onAccountChange}
          options={[{ v: '', label: 'Все ЛС' }, ...(accountsMeta.data ?? []).map(a => ({ v: a.id, label: a.label }))]}
        />
        <span className={styles.headerDates}>
          <select className={styles.monthSelect} value={selectedMonth} onChange={e => onPickMonth(e.target.value)}>
            {!months.some(m => m.value === selectedMonth) && <option value={selectedMonth}>Период…</option>}
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <input className={styles.dateInput} type="date" value={callsFrom} onChange={e => setCallsFrom(e.target.value)} />
          <span className={styles.headerDatesSep}>—</span>
          <input className={styles.dateInput} type="date" value={callsTo} onChange={e => setCallsTo(e.target.value)} />
        </span>
      </div>

      <section className={styles.card}>
        <div className={styles.cardTitleText} style={{ marginBottom: 12 }}>По лицевым счетам</div>
        {billingSummary.isLoading ? <p className={styles.hint}>Загрузка…</p> : billingAccounts.length === 0 ? (
          stepUnavailable('billing')
            ? <UnavailableNotice />
            : <p className={styles.hint}>Нет данных. Нажмите «Обновить» вверху страницы или дождитесь ежедневного автообновления.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Лицевой счёт</th><th>Баланс</th><th>Кредитный лимит</th><th>Неоплаченные</th><th>Обновлено</th></tr></thead>
              <tbody>
                {billingAccounts.map(r => (
                  <tr key={r.accountId}>
                    <td>{r.label}{r.accountNumber ? ` (${r.accountNumber})` : ''}</td>
                    <td>{fmtMoney(r.balance)}</td>
                    <td>{fmtMoney(r.creditLimit)}</td>
                    <td>
                      {(r.unpaidAmount ?? 0) > 0
                        ? <span className={`${styles.badge} ${styles.badgeErr}`}>{fmtMoney(r.unpaidAmount)}</span>
                        : fmtMoney(r.unpaidAmount)}
                    </td>
                    <td>{fmtLast(r.capturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.kpiGrid}>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Начисления за период</div>
            <div className={styles.kpiValue}>{fmtMoney(totalCharges)}</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Время разговоров</div>
            <div className={styles.kpiValue}>
              {!accSummary.isLoading && totalCalls === 0 ? '—' : fmtDur(totalSec)}
            </div>
            <div className={`${styles.kpiSub} ${styles.kpiSubMuted}`}>
              {!accSummary.isLoading && totalCalls === 0 ? 'нет данных за период' : `${totalCalls.toLocaleString('ru-RU')} звонков`}
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>
              {totalUnpaid > 0 && <span className={styles.liveDot} />}
              Неоплаченные счета
            </div>
            <div className={styles.kpiValue}>{fmtMoney(totalUnpaid)}</div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiLabel}>Заявки в обработке</div>
            <div className={styles.kpiValue}>{inProgressCount}</div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <span className={styles.cardTitleText}>Лицевые счета</span>
          <span className={styles.cardTitleExtra}>период с {callsFrom} по {callsTo}</span>
        </div>
        {accSummary.isLoading ? <p className={styles.hint}>Загрузка…</p>
          : accountsOverview.length === 0
            ? (stepUnavailable('detalization')
              ? <UnavailableNotice message="Детализация звонков не активирована для этого лицевого счёта." />
              : <p className={styles.hint}>Нет данных за период. Нажмите «Обновить» вверху страницы.</p>)
            : <>
                <div className={styles.propBar}>
                  {accountsOverview.map((r, i) => (
                    <div
                      key={r.accountId}
                      className={styles.propSegment}
                      style={{ width: `${Math.max(2, Math.round((r.totalSeconds / Math.max(1, accountsOverviewTotal)) * 100))}%`, background: ACCENT_PALETTE[i % ACCENT_PALETTE.length] }}
                      title={r.label ?? undefined}
                    />
                  ))}
                </div>
                <div className={styles.legend}>
                  {accountsOverview.map((r, i) => (
                    <span key={r.accountId} className={styles.legendItem}>
                      <span className={styles.legendDot} style={{ background: ACCENT_PALETTE[i % ACCENT_PALETTE.length] }} />
                      {r.label ?? 'Без названия'} <span className={styles.legendValue}>{fmtDur(r.totalSeconds)}</span>
                      {r.unpaidAmount != null && r.unpaidAmount > 0 && (
                        <span className={`${styles.badge} ${styles.badgeErr}`}>{fmtMoney(r.unpaidAmount)}</span>
                      )}
                    </span>
                  ))}
                </div>
              </>}
      </section>

      {/* Объединённая секция: топ по времени/начислениям + справочник по сотрудникам.
          Клик по строке открывает карточку абонента (как на вкладке «Абоненты»). */}
      <section className={styles.card}>
        <div className={`${styles.cardTitle} ${styles.empHead}`}>
          <span className={styles.cardTitleText}>Сотрудники</span>
          <Seg value={topMetric} onChange={v => setTopMetric(v as 'time' | 'cost')} options={[{ v: 'time', label: 'По времени' }, { v: 'cost', label: 'По начислениям' }]} />
        </div>
        <div className={styles.empToolbar}>
          <input
            className={styles.search}
            type="search"
            placeholder="Поиск: ФИО, табельный…"
            value={empSearch}
            onChange={e => setEmpSearch(e.target.value)}
          />
          <select className={styles.select} value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">Все отделы</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        {(report.isLoading || billingSummary.isLoading) ? (
          <p className={styles.hint}>Загрузка…</p>
        ) : topItems.length === 0 ? (
          empQuery || deptFilter
            ? <p className={styles.hint}>Ничего не найдено.</p>
            : (stepUnavailable(topMetric === 'time' ? 'detalization' : 'billing')
              ? <UnavailableNotice />
              : <p className={styles.hint}>Нет данных. Нажмите «Обновить» вверху страницы и привяжите номера к сотрудникам.</p>)
        ) : (
          <>
            <div>{topTop.map((r, i) => renderEmployeeRow(r, i))}</div>
            {topRest.length > 0 && (
              <>
                <button className={styles.moreBtn} onClick={() => setShowRestEmployees(!showRestEmployees)}>
                  {showRestEmployees ? 'Свернуть' : `Остальные · ${topRest.length}`}
                </button>
                {showRestEmployees && <div>{topRest.map((r, i) => renderEmployeeRow(r, TOP_N + i))}</div>}
              </>
            )}
          </>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <span className={styles.cardTitleText}>Динамика</span>
          <div className={styles.empControls}>
            <Seg value={trendMetric} onChange={v => setTrendMetric(v as MtsBusinessDailyMetric)} options={[{ v: 'balance', label: 'Баланс' }, { v: 'unpaid_amount', label: 'Неоплаченные' }]} />
            <input className={styles.dateInput} type="date" value={trendFrom} onChange={e => setTrendFrom(e.target.value)} />
            <input className={styles.dateInput} type="date" value={trendTo} onChange={e => setTrendTo(e.target.value)} />
          </div>
        </div>
        {trend.isLoading ? <p className={styles.hint}>Загрузка…</p>
          : (trend.data ?? []).length === 0 && stepUnavailable('billing') ? <UnavailableNotice />
          : (
          <div className={styles.chartWrap}>
            <ResponsiveContainer>
              <AreaChart data={trend.data ?? []} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="mtsOverviewTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} dy={6} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={44} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} tickFormatter={v => `${Math.round(v / 1000)}к`} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--text-tertiary)', strokeDasharray: '3 3' }} />
                <Area dataKey="amount" stroke="var(--primary)" strokeWidth={2} fill="url(#mtsOverviewTrend)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitleText} style={{ marginBottom: 12 }}>Остатки пакетов по лицевым счетам</div>
        {accountsPackages.isLoading ? <p className={styles.hint}>Загрузка…</p> : (accountsPackages.data ?? []).every(a => a.packages.length === 0) ? (
          stepUnavailable('catalog')
            ? <UnavailableNotice />
            : <p className={styles.hint}>Нет данных — нажмите «Обновить» вверху страницы или дождитесь еженедельного автообновления.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Лицевой счёт</th><th>Пакеты</th><th>Обновлено</th></tr></thead>
              <tbody>
                {(accountsPackages.data ?? []).filter(a => a.packages.length > 0).map(a => (
                  <tr key={a.accountId}>
                    <td>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</td>
                    <td>{a.packages.map(fmtPackage).join(' · ')}</td>
                    <td>{fmtLast(a.capturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {drawerRow && <SubscriberDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />}
    </div>
  );
};
