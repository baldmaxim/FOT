import { type CSSProperties, type FC, type ReactNode, useMemo, useState } from 'react';
import { useMtsBusinessSubscriberUsage } from '../../../hooks/useMtsBusinessSubscribers';
import type { IMtsUsageRow } from '../../../services/mtsBusinessSubscribersService';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { fmtLast, fmtMoney, fmtPhone, parseUsageSubtype, usageContactColor } from '../mtsBusinessFormat';
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
  usageGroupsFromTotals,
  usageTooltip,
} from '../usageSummary';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

const USAGE_ROWS_CAP = 1500;

/* ---- Иконка типа события (звонок ↗/↙, интернет, СМС, прочее) ---- */

const ICONS: Record<string, ReactNode> = {
  out: <><line x1="7" y1="17" x2="17" y2="7" /><polyline points="8 7 17 7 17 16" /></>,
  in: <><line x1="17" y1="7" x2="7" y2="17" /><polyline points="16 17 7 17 7 8" /></>,
  call: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />,
  net: <><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z" /></>,
  sms: <><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22 6 12 13 2 6" /></>,
  other: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
};

const UsageIcon: FC<{ group: UsageGroupKey; direction: 'in' | 'out' | null }> = ({ group, direction }) => {
  let key: string;
  let cls: string;
  if (group === 'calls') {
    key = direction === 'in' ? 'in' : direction === 'out' ? 'out' : 'call';
    cls = direction === 'in' ? st.usageIcoIn : st.usageIcoOut;
  } else if (group === 'internet') { key = 'net'; cls = st.usageIcoNet; }
  else if (group === 'sms') { key = 'sms'; cls = st.usageIcoSms; }
  else { key = 'other'; cls = st.usageIcoOther; }
  return (
    <span className={`${st.usageIco} ${cls}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24" width="15" height="15"
        fill={key === 'other' ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      >
        {ICONS[key]}
      </svg>
    </span>
  );
};

/* ---- Одна строка детализации ---- */

const UsageRow: FC<{ u: IMtsUsageRow }> = ({ u }) => {
  const group = groupOf(u.category);
  const subtype = parseUsageSubtype(u.label);
  const name = u.peerName ?? null;
  const numberText = u.peer ? fmtPhone(u.peer) : null;
  const hasPeer = !!(u.peerName || u.peer);
  const primary = name ?? numberText ?? u.label ?? '—';
  const value = fmtUnits(u.units, u.unitCode);
  const paid = u.amount > 0; // событие оказалось платным (было списание)
  const dotStyle = { ['--c']: usageContactColor(u.peer ?? u.peerName) } as CSSProperties;
  return (
    <li className={`${st.usageRow} ${paid ? st.usageRowPaid : ''}`}>
      <UsageIcon group={group} direction={u.direction} />
      <div className={st.usageMain}>
        <div className={st.usagePrimary}>
          {hasPeer && <span className={st.usageDot} style={dotStyle} />}
          <span className={st.usageName}>{primary}</span>
          {name && numberText && <span className={st.usagePeerNum}>{numberText}</span>}
        </div>
        <div className={st.usageMeta}>
          <span className={st.usageChip}>{USAGE_TYPE_WORD[group]}</span>
          {subtype && <span className={st.usageSubtype}>{subtype}</span>}
          {paid && <span className={st.usagePaidChip}>платно</span>}
          <span className={st.usageTime}>{fmtLast(u.date)}</span>
        </div>
      </div>
      <div className={st.usageValueBox}>
        {value && <span className={st.usageValue}>{value}</span>}
        {paid && <span className={`${st.usageAmt} ${st.usageAmtPaid}`}>{fmtMoney(u.amount)}</span>}
      </div>
    </li>
  );
};

/**
 * Вкладка «Использование» карточки абонента: компактные плитки-сводка + детализация
 * выписки МТС с под-вкладками (Звонки / Интернет / СМС / Прочее) и оформленными строками.
 */
export const UsageTab: FC<{
  msisdn: string;
  month: string;
  months: { value: string; label: string }[];
  setMonth: (m: string) => void;
}> = ({ msisdn, month, months, setMonth }) => {
  const [usageDate, setUsageDate] = useState(''); // пусто = весь месяц
  const [showDetail, setShowDetail] = useState(false); // список выписки скрыт по умолчанию
  const [onlyPaid, setOnlyPaid] = useState(false); // фильтр: только события с суммой > 0
  const [detailTab, setDetailTab] = useState<UsageGroupKey>('calls');
  const usage = useMtsBusinessSubscriberUsage(msisdn, month, usageDate, true);
  const rows = usage.data?.rows;
  const totals = usage.data?.totals;
  // Плитки — по серверному агрегату (все строки периода), список — по rows
  // (может быть обрезан). Так админка, «Статистика» и ЛК дают одни цифры.
  const summary = useMemo(
    () => (totals ? usageGroupsFromTotals(totals, rows ?? []) : summarizeUsage(rows ?? [])),
    [totals, rows],
  );

  const availableTabs = useMemo(
    () => USAGE_GROUP_ORDER.filter(k => (summary.get(k)?.count ?? 0) > 0),
    [summary],
  );
  const activeTab = availableTabs.includes(detailTab) ? detailTab : (availableTabs[0] ?? 'calls');
  const tabRows = useMemo(
    () => (rows ?? []).filter(u => groupOf(u.category) === activeTab && (!onlyPaid || u.amount > 0)),
    [rows, activeTab, onlyPaid],
  );
  const paidCount = useMemo(() => (rows ?? []).filter(u => u.amount > 0).length, [rows]);
  // Событий за период — по агрегату (rows могут быть обрезаны лимитом сервера).
  const eventsTotal = useMemo(
    () => [...summary.values()].reduce((sum, g) => sum + g.count, 0),
    [summary],
  );

  const onMonth = (v: string): void => { setMonth(v); setUsageDate(''); setShowDetail(false); };
  const onDay = (v: string): void => { setUsageDate(v ? `${month}-${v}` : ''); setShowDetail(false); };

  return (
    <div className={st.section}>
      <div className={st.sectionHead}>
        <h4 className={st.sectionTitle}>Использование SIM — детальная выписка</h4>
        <span className={st.usageControls}>
          <select className={st.monthSelect} value={month} onChange={e => onMonth(e.target.value)}>
            {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select
            className={st.monthSelect}
            value={usageDate ? usageDate.slice(8) : ''}
            onChange={e => onDay(e.target.value)}
            title="День внутри выбранного месяца"
          >
            <option value="">Весь месяц</option>
            {Array.from({ length: daysInMonth(month) }, (_, i) => String(i + 1).padStart(2, '0'))
              .map(d => <option key={d} value={d}>{Number(d)}</option>)}
          </select>
        </span>
      </div>

      {usage.isLoading && <p className={styles.hint}>Загрузка выписки из МТС…</p>}
      {usage.isError && <p className={styles.err}>Не удалось загрузить выписку.</p>}
      {usage.data?.unavailable && <UnavailableNotice message="Детализация не активирована для этого лицевого счёта." />}

      {rows && (rows.length === 0
        ? <p className={styles.hint}>{usageDate ? `За ${usageDate} событий нет.` : 'За выбранный месяц событий нет.'}</p>
        : (
          <>
            <div className={st.usageStats}>
              {USAGE_GROUP_ORDER.map(k => {
                const g = summary.get(k);
                if (!g || (g.count === 0 && g.amount === 0)) return null;
                return (
                  <div key={k} className={st.usageStat} data-g={k} data-tooltip={usageTooltip(g)}>
                    <span className={st.usageStatLabel}>{USAGE_GROUP_LABELS[k]}</span>
                    <span className={st.usageStatValue}>{usageGroupValue(g)}</span>
                    <span className={st.usageStatSub}>{usageGroupSub(g)}</span>
                  </div>
                );
              })}
              <div className={`${st.usageStat} ${st.usageStatTotal}`} data-g="total">
                <span className={st.usageStatLabel}>Итого</span>
                <span className={st.usageStatValue}>{fmtMoney(usage.data?.total ?? 0)}</span>
                <span className={st.usageStatSub}>{eventsTotal} событий за {usageDate || 'месяц'}</span>
              </div>
            </div>

            <button
              className={st.itemBtn}
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => setShowDetail(v => !v)}
            >
              {showDetail ? '▴ Скрыть детализацию' : `▾ Детализация (${rows.length})`}
            </button>

            {showDetail && (
              <>
                <div className={st.usageTabs}>
                  {availableTabs.map(k => (
                    <button
                      key={k}
                      className={`${st.usageTab} ${activeTab === k ? st.usageTabActive : ''}`}
                      onClick={() => setDetailTab(k)}
                    >
                      {USAGE_GROUP_LABELS[k]}
                      <span className={st.usageTabCount}>{summary.get(k)?.count ?? 0}</span>
                    </button>
                  ))}
                  {paidCount > 0 && (
                    <button
                      className={`${st.usageTab} ${st.usagePaidToggle} ${onlyPaid ? st.usageTabActive : ''}`}
                      onClick={() => setOnlyPaid(v => !v)}
                      title="Показать только платные события"
                    >
                      ₽ Только платные
                      <span className={st.usageTabCount}>{paidCount}</span>
                    </button>
                  )}
                </div>

                {tabRows.length === 0
                  ? <p className={styles.hint}>{onlyPaid ? 'В этой категории нет платных событий.' : 'Событий нет.'}</p>
                  : (
                    <ul className={st.usageRowList}>
                      {tabRows.slice(0, USAGE_ROWS_CAP).map((u, i) => <UsageRow key={`u-${i}`} u={u} />)}
                    </ul>
                  )}
                {tabRows.length > USAGE_ROWS_CAP && (
                  <p className={styles.hint}>Показаны первые {USAGE_ROWS_CAP} из {tabRows.length} событий.</p>
                )}
              </>
            )}
          </>
        )
      )}
    </div>
  );
};
