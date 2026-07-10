import { type CSSProperties, type FC, type ReactNode, useMemo, useState } from 'react';
import { useMtsBusinessSubscriberUsage } from '../../../hooks/useMtsBusinessSubscribers';
import type { IMtsUsageRow } from '../../../services/mtsBusinessSubscribersService';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { fmtDur, fmtLast, fmtMoney, fmtPhone, parseUsageSubtype, usageContactColor } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

const USAGE_ROWS_CAP = 1500;

/** Число дней в месяце по строке YYYY-MM. */
const daysInMonth = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

/** Объём события выписки: секунды → длительность, байты → МБ, штуки → как есть. */
const fmtUnits = (units: number | null, code: string | null): string => {
  if (units == null) return '';
  if (code === 'SECOND') return fmtDur(units);
  if (code === 'BYTE') return `${(units / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  return String(units);
};

/* ---- Группировка строк выписки (звонки / интернет / СМС / прочее) ---- */

type UsageGroupKey = 'calls' | 'internet' | 'sms' | 'other';

interface IUsageLabelStat { label: string; count: number; seconds: number; bytes: number; amount: number }
interface IUsageGroup {
  key: UsageGroupKey;
  count: number;
  seconds: number;
  bytes: number;
  amount: number;
  byLabel: Map<string, IUsageLabelStat>;
  byDir: { in: { count: number; seconds: number }; out: { count: number; seconds: number } };
}

const USAGE_GROUP_OF: Record<string, UsageGroupKey> = {
  calls: 'calls', internet: 'internet', sms: 'sms',
  periodic: 'other', oneTime: 'other', topups: 'other', other: 'other',
};
const USAGE_GROUP_LABELS: Record<UsageGroupKey, string> = {
  calls: 'Звонки', internet: 'Интернет', sms: 'СМС', other: 'Прочее',
};
const USAGE_TYPE_WORD: Record<UsageGroupKey, string> = {
  calls: 'связь', internet: 'интернет', sms: 'смс', other: 'прочее',
};
const USAGE_GROUP_ORDER: UsageGroupKey[] = ['calls', 'internet', 'sms', 'other'];
const groupOf = (cat: string): UsageGroupKey => USAGE_GROUP_OF[cat] ?? 'other';

/** Раскладывает строки выписки по группам с разбивкой для тултипов плиток. */
const summarizeUsage = (rows: IMtsUsageRow[]): Map<UsageGroupKey, IUsageGroup> => {
  const groups = new Map<UsageGroupKey, IUsageGroup>();
  const ensure = (k: UsageGroupKey): IUsageGroup => {
    let g = groups.get(k);
    if (!g) {
      g = {
        key: k, count: 0, seconds: 0, bytes: 0, amount: 0, byLabel: new Map(),
        byDir: { in: { count: 0, seconds: 0 }, out: { count: 0, seconds: 0 } },
      };
      groups.set(k, g);
    }
    return g;
  };
  for (const r of rows) {
    const g = ensure(groupOf(r.category));
    const units = r.units ?? 0;
    const sec = r.unitCode === 'SECOND' ? units : 0;
    const byt = r.unitCode === 'BYTE' ? units : 0;
    g.count += 1; g.seconds += sec; g.bytes += byt; g.amount += r.amount;
    if (r.direction === 'in') { g.byDir.in.count += 1; g.byDir.in.seconds += sec; }
    else if (r.direction === 'out') { g.byDir.out.count += 1; g.byDir.out.seconds += sec; }
    const lk = r.label ?? r.networkEvent ?? '—';
    let ls = g.byLabel.get(lk);
    if (!ls) { ls = { label: lk, count: 0, seconds: 0, bytes: 0, amount: 0 }; g.byLabel.set(lk, ls); }
    ls.count += 1; ls.seconds += sec; ls.bytes += byt; ls.amount += r.amount;
  }
  return groups;
};

/** Главное значение плитки: звонки → длительность, интернет → объём, СМС → штуки, прочее → ₽. */
const usageGroupValue = (g: IUsageGroup): string => {
  if (g.key === 'calls') return fmtDur(g.seconds);
  if (g.key === 'internet') return fmtUnits(g.bytes, 'BYTE');
  if (g.key === 'sms') return `${g.count} шт`;
  return fmtMoney(g.amount);
};

/** Подстрока плитки: число событий + сумма (если есть). */
const usageGroupSub = (g: IUsageGroup): string =>
  `${g.count} соб.${g.amount > 0 ? ` · ${fmtMoney(g.amount)}` : ''}`;

/** Многострочный текст тултипа с разбивкой группы. */
const usageTooltip = (g: IUsageGroup): string => {
  if (g.key === 'calls') {
    const lines: string[] = [];
    if (g.byDir.in.count) lines.push(`Входящие: ${g.byDir.in.count} · ${fmtDur(g.byDir.in.seconds)}`);
    if (g.byDir.out.count) lines.push(`Исходящие: ${g.byDir.out.count} · ${fmtDur(g.byDir.out.seconds)}`);
    return lines.join('\n') || 'Нет данных';
  }
  const items = [...g.byLabel.values()];
  const weight = (x: IUsageLabelStat): number => (g.key === 'internet' ? x.bytes : (x.amount || x.count));
  items.sort((a, b) => weight(b) - weight(a));
  const top = items.slice(0, 8);
  const rest = items.length - top.length;
  const line = (x: IUsageLabelStat): string => {
    const vol = g.key === 'internet' ? fmtUnits(x.bytes, 'BYTE') : `${x.count} шт`;
    return `${x.label} — ${vol}${x.amount > 0 ? ` · ${fmtMoney(x.amount)}` : ''}`;
  };
  const lines = top.map(line);
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  return lines.join('\n') || 'Нет данных';
};

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
  const summary = useMemo(() => summarizeUsage(rows ?? []), [rows]);

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
                <span className={st.usageStatSub}>{rows.length} событий за {usageDate || 'месяц'}</span>
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
