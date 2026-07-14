import { type FC, useMemo, useState } from 'react';
import { useMySimUsage } from '../../../hooks/useMySim';
import type { IMtsUsageRow } from '../../../services/mtsBusinessSubscribersService';
import {
  type UsageGroupKey,
  USAGE_GROUP_LABELS,
  USAGE_GROUP_ORDER,
  USAGE_TYPE_WORD,
  daysInMonth,
  fmtUnits,
  groupOf,
  summarizeUsage,
  usageGroupSub,
  usageGroupValue,
  usageTooltip,
} from '../../mts-business/usageSummary';
import {
  MONTH_NAMES,
  fmtDay,
  fmtDur,
  fmtLast,
  fmtMoney,
  fmtPhone,
  parseUsageSubtype,
} from '../../mts-business/mtsBusinessFormat';
import styles from '../MySimPage.module.css';

const ROWS_CAP = 1500;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const currentYm = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

/** Одна строка детализации: направление, собеседник/описание, тип, время, объём, сумма. */
const UsageRow: FC<{ u: IMtsUsageRow }> = ({ u }) => {
  const group = groupOf(u.category);
  const subtype = parseUsageSubtype(u.label);
  const numberText = u.peer ? fmtPhone(u.peer) : null;
  const primary = u.peerName ?? numberText ?? u.label ?? '—';
  const value = fmtUnits(u.units, u.unitCode);
  const paid = u.amount > 0;
  // Глиф и цвет бейджа — как иконки в админке МТС Бизнес: входящий зелёный,
  // исходящий синий, интернет фиолетовый, СМС янтарный.
  const dirArrow = group === 'calls'
    ? (u.direction === 'in' ? '↓' : u.direction === 'out' ? '↑' : '·')
    : group === 'internet' ? '⇄' : group === 'sms' ? '✉' : '·';
  const dirCls = group === 'calls'
    ? (u.direction === 'in' ? styles.rowDirIn : u.direction === 'out' ? styles.rowDirOut : '')
    : group === 'internet' ? styles.rowIcoNet : group === 'sms' ? styles.rowIcoSms : '';
  return (
    <li className={`${styles.row} ${paid ? styles.rowPaid : ''}`}>
      <span className={`${styles.rowDir} ${dirCls}`} aria-hidden="true">{dirArrow}</span>
      <div className={styles.rowMain}>
        <div className={styles.rowPrimary}>
          {primary}
          {u.peerName && numberText && <span className={styles.rowPeerNum}>{numberText}</span>}
        </div>
        <div className={styles.rowMeta}>
          <span className={styles.rowChip}>{USAGE_TYPE_WORD[group]}</span>
          {subtype && <span>{subtype}</span>}
          {paid && <span className={styles.rowPaidChip}>платно</span>}
          <span>{fmtLast(u.date)}</span>
        </div>
      </div>
      <div className={styles.rowValueBox}>
        {value && <span className={styles.rowValue}>{value}</span>}
        {paid && <span className={styles.rowAmt}>{fmtMoney(u.amount)}</span>}
      </div>
    </li>
  );
};

/**
 * Использование SIM в ЛК: плитки-сводка (Звонки/Интернет/СМС/Прочее), таблица
 * «По дням» и построчная детализация. Данные из БД (обновляются ночным прогоном
 * МТС) — селектор месяцев ограничен месяцами, за которые есть выписка.
 */
export const MySimUsage: FC<{ msisdn: string; months: string[] }> = ({ msisdn, months }) => {
  const monthOptions = months.length > 0 ? months : [currentYm()];
  const [month, setMonth] = useState(monthOptions[0]);
  const [usageDate, setUsageDate] = useState(''); // пусто = весь месяц
  const [detailTab, setDetailTab] = useState<UsageGroupKey>('calls');

  const usage = useMySimUsage(month, usageDate);
  const my = useMemo(
    () => usage.data?.numbers.find(n => n.msisdn === msisdn) ?? null,
    [usage.data, msisdn],
  );
  const rows = usage.data ? my?.rows ?? [] : undefined;
  const summary = useMemo(() => summarizeUsage(my?.rows ?? []), [my]);

  const availableTabs = useMemo(
    () => USAGE_GROUP_ORDER.filter(k => (summary.get(k)?.count ?? 0) > 0),
    [summary],
  );
  const activeTab = availableTabs.includes(detailTab) ? detailTab : (availableTabs[0] ?? 'calls');
  const tabRows = useMemo(
    () => (my?.rows ?? []).filter(u => groupOf(u.category) === activeTab),
    [my, activeTab],
  );

  const onMonth = (v: string): void => { setMonth(v); setUsageDate(''); };
  const onDay = (v: string): void => { setUsageDate(v ? `${month}-${v}` : ''); };

  return (
    <div className={styles.card}>
      <div className={styles.usageHead}>
        <h3 className={styles.usageTitle}>Использование</h3>
        <span className={styles.usageControls}>
          <select className={styles.select} value={month} onChange={e => onMonth(e.target.value)}>
            {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <select
            className={styles.select}
            value={usageDate ? usageDate.slice(8) : ''}
            onChange={e => onDay(e.target.value)}
            title="День внутри выбранного месяца"
          >
            <option value="">Весь месяц</option>
            {Array.from({ length: daysInMonth(month) }, (_, i) => pad2(i + 1))
              .map(d => <option key={d} value={d}>{Number(d)}</option>)}
          </select>
        </span>
      </div>

      {usage.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {usage.isError && <p className={styles.err}>Не удалось загрузить данные.</p>}

      {rows && (rows.length === 0
        ? (
          <p className={styles.hint}>
            {usageDate ? `За ${fmtDay(usageDate)} событий нет.` : 'За выбранный месяц данных нет — выписка обновляется каждую ночь.'}
          </p>
        )
        : (
          <>
            <div className={styles.stats}>
              {USAGE_GROUP_ORDER.map(k => {
                const g = summary.get(k);
                if (!g || (g.count === 0 && g.amount === 0)) return null;
                return (
                  <div key={k} className={styles.stat} data-g={k} title={usageTooltip(g)}>
                    <span className={styles.statLabel}>{USAGE_GROUP_LABELS[k]}</span>
                    <span className={styles.statValue}>{usageGroupValue(g)}</span>
                    <span className={styles.statSub}>{usageGroupSub(g)}</span>
                  </div>
                );
              })}
              <div className={`${styles.stat} ${styles.statTotal}`}>
                <span className={styles.statLabel}>Итого</span>
                <span className={styles.statValue}>{fmtMoney(my?.total ?? 0)}</span>
                <span className={styles.statSub}>{rows.length} событий</span>
              </div>
            </div>

            <div className={!usageDate && (my?.days.length ?? 0) > 1 ? styles.usageGrid : styles.usageGridSingle}>
              {!usageDate && (my?.days.length ?? 0) > 1 && (
                <div className={styles.daysWrap}>
                  <div className={styles.panelTitle}>По дням</div>
                  <div className={styles.daysScroll}>
                    <table className={styles.daysTable}>
                      <thead>
                        <tr>
                          <th>День</th>
                          <th>Звонки</th>
                          <th>СМС</th>
                          <th>Интернет</th>
                          <th>Сумма</th>
                        </tr>
                      </thead>
                      <tbody>
                        {my?.days.map(d => (
                          <tr key={d.date}>
                            <td className={styles.daysDate}>{fmtDay(d.date)}</td>
                            <td>{d.calls > 0 ? `${d.calls} зв · ${fmtDur(d.callsSeconds)}` : '—'}</td>
                            <td>{d.smsCount > 0 ? `${d.smsCount} шт` : '—'}</td>
                            <td>{d.internetBytes > 0 ? fmtUnits(d.internetBytes, 'BYTE') : '—'}</td>
                            <td>{d.amount > 0 ? fmtMoney(d.amount) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className={styles.detailPanel}>
                <div className={styles.panelTitle}>Детализация ({rows.length})</div>
                <div className={styles.groupTabs}>
                  {availableTabs.map(k => (
                    <button
                      key={k}
                      className={`${styles.groupTab} ${activeTab === k ? styles.groupTabActive : ''}`}
                      onClick={() => setDetailTab(k)}
                    >
                      {USAGE_GROUP_LABELS[k]}
                      <span className={styles.groupTabCount}>{summary.get(k)?.count ?? 0}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.rowScroll}>
                  <ul className={styles.rowList}>
                    {tabRows.slice(0, ROWS_CAP).map((u, i) => <UsageRow key={`u-${i}`} u={u} />)}
                  </ul>
                </div>
                {tabRows.length > ROWS_CAP && (
                  <p className={styles.hint}>Показаны первые {ROWS_CAP} из {tabRows.length} событий.</p>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
};
