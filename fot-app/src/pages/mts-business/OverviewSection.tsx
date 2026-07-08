import { type FC, useMemo, useState } from 'react';
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
import type { MtsBusinessDailyMetric } from '../../services/mtsBusinessBillingService';
import { RefreshAllPanel } from './overview/RefreshAllPanel';
import { UnavailableNotice } from './common/UnavailableNotice';
import { toISODate, fmtDur, fmtLast, fmtMoney, fmtPackage, ACTION_TYPE_LABELS, lastMonths, monthRange } from './mtsBusinessFormat';
import styles from './OverviewSection.module.css';

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  completed: { cls: styles.badgeOk, label: 'готово' },
  in_progress: { cls: styles.badgeWait, label: 'в обработке' },
  faulted: { cls: styles.badgeErr, label: 'ошибка' },
  unknown: { cls: styles.badgeMuted, label: '—' },
};

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

const Bars: FC<{
  items: { key: string; label: string; sub?: string; badge?: string; value: number; active?: boolean; onClick?: () => void }[];
  formatValue: (v: number) => string;
}> = ({ items, formatValue }) => {
  const max = Math.max(1, ...items.map(i => i.value));
  return (
    <div>
      {items.map((it, i) => (
        <div
          key={it.key}
          className={`${styles.barRow} ${it.onClick ? styles.barRowClickable : ''} ${it.active ? styles.barRowActive : ''}`}
          onClick={it.onClick}
        >
          <span className={styles.barIndex}>{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div className={styles.barLabel}>
              {it.label}
              {it.sub && <span className={styles.barSub}> · {it.sub}</span>}
              {it.badge && <span className={styles.barBadge}>{it.badge}</span>}
            </div>
            <div className={styles.barTrack}><div className={styles.barFill} style={{ width: `${Math.round((it.value / max) * 100)}%` }} /></div>
          </div>
          <div className={styles.barValue}>{formatValue(it.value)}</div>
        </div>
      ))}
    </div>
  );
};

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
  const [empPageState, setEmpPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 });

  const accountsMeta = useMtsBusinessAccounts();
  const accSummary = useMtsBusinessAccountsSummary(callsFrom, callsTo, true);
  const report = useMtsBusinessReport(callsFrom, callsTo, true, accountId || undefined);
  const billingSummary = useMtsBusinessBillingSummary(callsFrom, callsTo);
  const trend = useMtsBusinessBillingTrend(trendMetric, trendFrom, trendTo, accountId || undefined);
  const employeesCatalog = useMtsBusinessEmployeesCatalog(accountId || undefined);
  const accountsPackages = useMtsBusinessAccountsPackages();
  const actions = useMtsBusinessActions(true);
  const refreshAllStatus = useMtsBusinessRefreshAllStatus();

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
  const billingEmployees = billingSummary.data?.employees ?? [];
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

  const billingEmployeesEnriched = billingEmployees.map(r => {
    const key = r.employeeId != null ? String(r.employeeId) : `unmapped-${r.employeeFullName ?? ''}`;
    const c = catalogByEmployee.get(key);
    return {
      ...r,
      tariffName: c ? [...c.tariffNames].join(', ') || null : null,
      servicesCount: c?.servicesCount ?? 0,
      servicesMonthlyTotal: c?.servicesMonthlyTotal ?? 0,
      // «Обновлено» — свежесть любого из источников (начисления/тариф/услуги).
      capturedAt: maxIso(r.capturedAt, c?.maxCapturedAt ?? null),
    };
  });

  // Таблица «По сотрудникам»: поиск по ФИО/табельному + пагинация по 50.
  const EMP_PAGE_SIZE = 50;
  const empQuery = empSearch.trim().toLowerCase();
  const empFiltered = empQuery
    ? billingEmployeesEnriched.filter(r =>
        `${r.employeeFullName ?? ''} ${r.employeeTabNumber ?? ''}`.toLowerCase().includes(empQuery))
    : billingEmployeesEnriched;
  const empPage = empPageState.key === empSearch ? empPageState.page : 1;
  const setEmpPage = (p: number): void => setEmpPageState({ key: empSearch, page: p });
  const empPageCount = Math.max(1, Math.ceil(empFiltered.length / EMP_PAGE_SIZE));
  const empSafePage = Math.min(empPage, empPageCount);
  const empPageRows = empFiltered.slice((empSafePage - 1) * EMP_PAGE_SIZE, empSafePage * EMP_PAGE_SIZE);

  const TOP_N = 10;
  const timeItems = (report.data ?? [])
    .filter(r => r.employeeId != null || r.calls > 0)
    .slice()
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .map((r, i) => ({
      key: r.employeeId != null ? String(r.employeeId) : `unmapped-${i}`,
      label: r.employeeFullName ?? 'Не привязанные номера',
      sub: [r.employeeTabNumber, `${r.calls} зв.`].filter(Boolean).join(' · '),
      value: r.totalSeconds,
    }));
  const costItems = billingEmployeesEnriched
    .filter(r => (r.chargesAmount ?? 0) > 0)
    .slice()
    .sort((a, b) => (b.chargesAmount ?? 0) - (a.chargesAmount ?? 0))
    .map((r, i) => ({
      key: r.employeeId != null ? String(r.employeeId) : `unmapped-${i}`,
      label: r.employeeFullName ?? 'Не привязан',
      sub: r.employeeTabNumber ?? undefined,
      badge: r.tariffName ?? undefined,
      value: r.chargesAmount ?? 0,
    }));
  const topItems = topMetric === 'time' ? timeItems : costItems;
  const topTop = topItems.slice(0, TOP_N);
  const topRest = topItems.slice(TOP_N);

  const accountsOverview = accRows.map(r => {
    const billing = billingAccounts.find(b => b.accountId === r.accountId);
    return { ...r, balance: billing?.balance ?? null, unpaidAmount: billing?.unpaidAmount ?? null };
  }).filter(r => r.accountId);
  const accountsOverviewTotal = accountsOverview.reduce((a, r) => a + r.totalSeconds, 0);

  const recentActions = (actions.data ?? []).slice(0, 6);

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

      <RefreshAllPanel />

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

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            <span className={styles.cardTitleText}>Топ сотрудников</span>
            <Seg value={topMetric} onChange={v => setTopMetric(v as 'time' | 'cost')} options={[{ v: 'time', label: 'По времени' }, { v: 'cost', label: 'По начислениям' }]} />
          </div>
          {(topMetric === 'time' ? report.isLoading : billingSummary.isLoading) ? (
            <p className={styles.hint}>Загрузка…</p>
          ) : topItems.length === 0 ? (
            stepUnavailable(topMetric === 'time' ? 'detalization' : 'billing')
              ? <UnavailableNotice />
              : <p className={styles.hint}>Нет данных. Нажмите «Обновить» вверху страницы и привяжите номера к сотрудникам.</p>
          ) : (
            <>
              <Bars items={topTop} formatValue={topMetric === 'time' ? fmtDur : v => fmtMoney(v)} />
              {topRest.length > 0 && (
                <>
                  <button className={styles.moreBtn} onClick={() => setShowRestEmployees(!showRestEmployees)}>
                    {showRestEmployees ? 'Свернуть' : `Остальные · ${topRest.length}`}
                  </button>
                  {showRestEmployees && <Bars items={topRest} formatValue={topMetric === 'time' ? fmtDur : v => fmtMoney(v)} />}
                </>
              )}
            </>
          )}
        </section>

        <div className={styles.stack}>
          <section className={styles.card}>
            <div className={styles.cardTitle}>
              <span className={styles.cardTitleText}>Динамика</span>
              <Seg value={trendMetric} onChange={v => setTrendMetric(v as MtsBusinessDailyMetric)} options={[{ v: 'balance', label: 'Баланс' }, { v: 'unpaid_amount', label: 'Неоплаченные' }]} />
            </div>
            <div className={styles.actions} style={{ marginBottom: 12 }}>
              <input className={styles.dateInput} type="date" value={trendFrom} onChange={e => setTrendFrom(e.target.value)} />
              <input className={styles.dateInput} type="date" value={trendTo} onChange={e => setTrendTo(e.target.value)} />
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
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} dy={6} />
                    <YAxis tickLine={false} axisLine={false} width={44} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} tickFormatter={v => `${Math.round(v / 1000)}к`} />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--text-tertiary)', strokeDasharray: '3 3' }} />
                    <Area dataKey="amount" stroke="var(--primary)" strokeWidth={2} fill="url(#mtsOverviewTrend)" dot={{ r: 2.5, fill: 'var(--primary)', strokeWidth: 0 }} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardTitle}>
              <span className={styles.cardTitleText}>Последние заявки</span>
            </div>
            {recentActions.length === 0 ? (
              <p className={styles.hint}>Заявок нет.</p>
            ) : recentActions.map(a => {
              const badge = STATUS_BADGE[a.status] ?? STATUS_BADGE.unknown;
              return (
                <div key={a.eventId} className={styles.eventRow}>
                  <div style={{ minWidth: 0 }}>
                    <div className={styles.eventTitle}>{ACTION_TYPE_LABELS[a.actionType] ?? a.actionType}</div>
                    <div className={styles.eventMeta}>{fmtLast(a.requestedAt)}</div>
                  </div>
                  <span className={`${styles.badge} ${badge.cls}`}>{badge.label}</span>
                </div>
              );
            })}
          </section>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <div className={styles.cardTitleText}>По сотрудникам</div>
          {billingEmployees.length > 0 && (
            <input
              className={styles.search}
              type="search"
              placeholder="Поиск: ФИО, табельный…"
              value={empSearch}
              onChange={e => setEmpSearch(e.target.value)}
            />
          )}
        </div>
        {billingSummary.isLoading ? (
          <p className={styles.hint}>Загрузка…</p>
        ) : billingEmployees.length === 0 ? (
          stepUnavailable('billing')
            ? <UnavailableNotice />
            : <p className={styles.hint}>Нет данных — привяжите номера к сотрудникам на вкладке «Администрирование».</p>
        ) : empFiltered.length === 0 ? (
          <p className={styles.hint}>Ничего не найдено.</p>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Сотрудник</th><th>Тариф</th><th>Начисления</th><th>Услуги</th><th>Обновлено</th></tr></thead>
                <tbody>
                  {empPageRows.map((r, i) => (
                    <tr key={r.employeeId ?? `unmapped-${i}`}>
                      <td>{r.employeeFullName ?? 'Не привязан'}{r.employeeTabNumber ? ` (таб. ${r.employeeTabNumber})` : ''}</td>
                      <td>{r.tariffName ?? '—'}</td>
                      <td>{fmtMoney(r.chargesAmount)}</td>
                      <td>{r.servicesCount > 0 ? `${r.servicesCount} · ${fmtMoney(r.servicesMonthlyTotal)}/мес` : '—'}</td>
                      <td>{fmtLast(r.capturedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {empPageCount > 1 && (
              <div className={styles.pager}>
                <button className={styles.btnSecondary} disabled={empSafePage <= 1} onClick={() => setEmpPage(empSafePage - 1)}>‹ Назад</button>
                <span className={styles.pagerInfo}>
                  {empSafePage} / {empPageCount} · строки {(empSafePage - 1) * EMP_PAGE_SIZE + 1}–{Math.min(empSafePage * EMP_PAGE_SIZE, empFiltered.length)}
                </span>
                <button className={styles.btnSecondary} disabled={empSafePage >= empPageCount} onClick={() => setEmpPage(empSafePage + 1)}>Вперёд ›</button>
              </div>
            )}
          </>
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
    </div>
  );
};
