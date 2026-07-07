import { type FC, type ReactNode, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useMtsBusinessSubscriberDetails,
  useMtsBusinessSubscriberUsage,
  useRefreshMtsBusinessSubscriber,
} from '../../../hooks/useMtsBusinessSubscribers';
import { useMtsBusinessSubscriberExpenses } from '../../../hooks/useMtsBusinessSubscriberData';
import { useModifyMtsBusinessService } from '../../../hooks/useMtsBusinessActionsData';
import { useSetMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import type { IMtsSubscriberRow, IMtsUsageRow } from '../../../services/mtsBusinessSubscribersService';
import type { IMtsSubServiceItem } from '../../../services/mtsBusinessSubscriberService';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { ConnectModal, type ConnectKind } from './ConnectModal';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { EmployeeFioPicker } from '../../mts/EmployeeFioPicker';
import {
  errText, fmtDur, fmtLast, fmtMoney, fmtPackage, fmtPhone,
  EXPENSE_CATEGORY_LABELS, FORWARDING_TYPE_LABELS, PD_STATUS_LABELS,
} from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const lastMonths = (n: number): { value: string; label: string }[] => {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({ value: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[m]} ${y}` });
    d.setMonth(m - 1);
  }
  return out;
};

const dash = (v: string | number | null | undefined): string => (v == null || v === '' ? '—' : String(v));

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

/** Платные услуги сверху (по убыванию абонплаты), затем бесплатные. */
const sortPaidFirst = (items: IMtsSubServiceItem[]): IMtsSubServiceItem[] =>
  [...items].sort((a, b) => (b.monthlyAmount ?? 0) - (a.monthlyAmount ?? 0));

const USAGE_ROWS_CAP = 1500;

/* ---- Сводка использования SIM (агрегация строк выписки на клиенте) ---- */

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
  calls: 'Звонки', internet: 'Интернет', sms: 'SMS', other: 'Прочее',
};
const USAGE_GROUP_ORDER: UsageGroupKey[] = ['calls', 'internet', 'sms', 'other'];

/** Раскладывает строки выписки по группам (звонки/интернет/SMS/прочее) с разбивкой для тултипов. */
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
    const g = ensure(USAGE_GROUP_OF[r.category] ?? 'other');
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

/** Главное значение плитки: звонки → длительность, интернет → объём, SMS → штуки, прочее → ₽. */
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

const KV: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <div className={st.kv}>
    <span className={st.kvLabel}>{label}</span>
    <span className={st.kvVal}>{value}</span>
  </div>
);

const EXPENSE_ORDER = ['calls', 'sms', 'internet', 'periodic', 'oneTime', 'topups', 'other'] as const;

/**
 * Боковая панель абонента (40% экрана): данные из сохранённых снапшотов,
 * управление услугами/блокировками/тарифом, привязка к сотруднику ФОТ,
 * персональные данные, статистика разговоров/расходов/пополнений.
 */
export const SubscriberDrawer: FC<{ row: IMtsSubscriberRow; onClose: () => void }> = ({ row, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const msisdn = row.msisdn as string;
  const details = useMtsBusinessSubscriberDetails(msisdn);
  const refresh = useRefreshMtsBusinessSubscriber();
  const modify = useModifyMtsBusinessService();
  const setMap = useSetMtsBusinessNumberMap();
  const months = useMemo(() => lastMonths(6), []);
  const [month, setMonth] = useState(months[0].value);
  const expenses = useMtsBusinessSubscriberExpenses(msisdn, month, true);
  const [pdOpen, setPdOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [view, setView] = useState<'main' | 'usage'>('main');
  const [usageDate, setUsageDate] = useState(''); // пусто = весь месяц
  const [showDetail, setShowDetail] = useState(false); // список выписки скрыт по умолчанию
  const [editLink, setEditLink] = useState(false); // редактирование привязки к сотруднику (карандаш)
  const [connectKind, setConnectKind] = useState<ConnectKind | null>(null); // модалка «+» / смены тарифа
  const usage = useMtsBusinessSubscriberUsage(msisdn, month, usageDate, view === 'usage');
  const usageSummary = useMemo(() => summarizeUsage(usage.data?.rows ?? []), [usage.data?.rows]);

  const accountId = details.data?.accountId ?? row.accountId ?? '';
  const busy = modify.isPending || refresh.isPending || setMap.isPending;

  const onModify = async (kind: 'service' | 'block', mode: 'add' | 'remove', item: IMtsSubServiceItem): Promise<void> => {
    const code = item.code;
    if (!code || !accountId) return;
    const verb = mode === 'add' ? (kind === 'block' ? 'Подключить блокировку' : 'Подключить услугу') : (kind === 'block' ? 'Снять блокировку' : 'Отключить услугу');
    if (!window.confirm(`${verb} «${item.name ?? code}» на номере ${msisdn}? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await modify.mutateAsync({ accountId, msisdn, externalID: code, kind, mode });
      setMsg({ ok: true, text: `Заявка отправлена (eventId ${r.eventId}) — статус в журнале заявок` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onLink = async (employeeId: number | null): Promise<void> => {
    setMsg(null);
    try {
      await setMap.mutateAsync({ msisdn, employeeId });
      setMsg({ ok: true, text: employeeId != null ? 'Привязка сохранена' : 'Привязка снята' });
      setEditLink(false);
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка привязки (возможно нужен 2FA)') });
    }
  };

  const onRefresh = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await refresh.mutateAsync(msisdn);
      setMsg({ ok: r.failed === 0, text: `Обновлено секций: ${r.stored} из ${r.sections}${r.unavailable ? `, не подключено в тарифе: ${r.unavailable}` : ''}${r.failed ? `, ошибок: ${r.failed}` : ''}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка обновления (возможно нужен 2FA)') });
    }
  };

  const d = details.data;

  const serviceList = (items: IMtsSubServiceItem[], kind: 'service' | 'block', mode: 'add' | 'remove', emptyText: string): ReactNode =>
    items.length === 0 ? <p className={styles.hint}>{emptyText}</p> : (
      <ul className={st.list}>
        {items.map((it, i) => (
          <li key={it.code ?? `it-${i}`} className={st.listItem}>
            <span className={st.listName}>{dash(it.name ?? it.code)}</span>
            <span className={st.listPrice}>{it.monthlyAmount != null && it.monthlyAmount > 0 ? `${fmtMoney(it.monthlyAmount)}/мес` : ''}</span>
            <button className={st.itemBtn} disabled={busy || !it.code} onClick={() => { void onModify(kind, mode, it); }}>
              {mode === 'add' ? 'Подключить' : kind === 'block' ? 'Снять' : 'Отключить'}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className={st.drawerOverlay} {...overlay}>
      <div className={st.drawer}>
        <div className={st.drawerHeader}>
          <div>
            <h3 className={st.drawerTitle}>
              <a className={st.phoneLink} href={`tel:+${msisdn.replace(/\D/g, '')}`} title="Позвонить">{fmtPhone(msisdn)}</a>
            </h3>
            <p className={st.drawerSub}>
              {[row.employeeFullName ?? row.mtsFio ?? row.mtsComment, row.departmentName, row.accountLabel, row.tariffName].filter(Boolean).join(' · ') || 'Абонент МТС'}
            </p>
          </div>
          <button className={st.drawerClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

        <div className={st.drawerTabs}>
          <button className={`${st.drawerTab} ${view === 'main' ? st.drawerTabActive : ''}`} onClick={() => setView('main')}>Управление</button>
          <button className={`${st.drawerTab} ${view === 'usage' ? st.drawerTabActive : ''}`} onClick={() => setView('usage')}>Использование</button>
          <button className={st.itemBtn} style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => { void onRefresh(); }}>
            {refresh.isPending ? 'Обновление…' : 'Обновить данные из МТС'}
          </button>
        </div>

        {view === 'main' && (<>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Статистика</h4>
            <select className={st.monthSelect} value={month} onChange={e => setMonth(e.target.value)}>
              {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <KV label="Звонки (всего в базе)" value={`${row.calls} · ${fmtDur(row.totalSeconds)}`} />
          <KV label="Последний звонок" value={fmtLast(row.lastCallAt)} />
          {expenses.isLoading && <p className={styles.hint}>Загрузка расходов…</p>}
          {expenses.data && (
            <>
              {EXPENSE_ORDER.map(cat => {
                const b = expenses.data.summary[cat];
                if (!b || (b.count === 0 && b.amount === 0)) return null;
                return <KV key={cat} label={EXPENSE_CATEGORY_LABELS[cat]} value={`${b.count ? `${b.count} · ` : ''}${fmtMoney(b.amount)}`} />;
              })}
              <KV label="Итого расходов" value={<b>{fmtMoney(expenses.data.summary.total)}</b>} />
            </>
          )}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}><h4 className={st.sectionTitle}>Абонент</h4></div>
          <KV label="ФИО в МТС" value={dash(row.mtsFio)} />
          <KV label="Комментарий МТС" value={dash(row.mtsComment)} />
          <KV label="Лицевой счёт" value={dash(row.accountLabel)} />
          <KV
            label="Сотрудник ФОТ"
            value={(row.employeeId != null && !editLink)
              ? (
                <>
                  {row.employeeFullName}{row.employeeTabNumber ? ` (таб. ${row.employeeTabNumber})` : ''}{row.departmentName ? ` · ${row.departmentName}` : ''}
                  <button
                    className={st.editBtn}
                    title="Изменить привязку"
                    aria-label="Изменить привязку"
                    disabled={busy}
                    onClick={() => setEditLink(v => !v)}
                  >
                    ✎
                  </button>
                </>
              )
              : (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <EmployeeFioPicker
                    disabled={busy}
                    placeholder={row.employeeId != null ? 'Сменить сотрудника…' : 'Привязать по ФИО…'}
                    onSelect={id => { void onLink(id); }}
                  />
                  {row.employeeId != null && (
                    <>
                      <button className={styles.btnSecondary} disabled={busy} onClick={() => { void onLink(null); }}>Снять</button>
                      <button className={styles.btnSecondary} disabled={busy} onClick={() => setEditLink(false)}>Отмена</button>
                    </>
                  )}
                </span>
              )}
          />
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Персональные данные</h4>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <PersonalDataStatusBadge status={row.pdStatus} />
              <button className={styles.btn} style={{ padding: '4px 10px', fontSize: 12, minHeight: 0 }} onClick={() => setPdOpen(true)}>Изменить</button>
            </span>
          </div>
          {(() => {
            const pd = details.data?.personalData ?? null;
            const statusVal = row.pdStatus ? (PD_STATUS_LABELS[row.pdStatus] ?? row.pdStatus) : 'не проверено — обновите данные';
            if (!pd) {
              return (
                <>
                  <KV label="ФИО по данным МТС" value={dash(row.mtsFio)} />
                  <KV label="Статус" value={statusVal} />
                  <KV label="Проверено" value={fmtLast(row.pdSyncedAt)} />
                  <p className={styles.hint}>
                    Полные персональные данные (паспорт, дата рождения) появятся после «Обновить данные из МТС»,
                    если внесены на стороне МТС. Внесение/изменение уходит в МТС; пользователь подтверждает через
                    Госуслуги (придёт SMS).
                  </p>
                </>
              );
            }
            return (
              <>
                <KV label="ФИО" value={dash(pd.fullName ?? row.mtsFio)} />
                <KV label="Дата рождения" value={dash(pd.birthDate)} />
                {pd.documents.length === 0 && <KV label="Документ" value="—" />}
                {pd.documents.map((doc, i) => {
                  const seriesNo = [doc.documentSeries, doc.documentNo].filter(Boolean).join(' ') || null;
                  const docLabel = pd.documents.length > 1 ? `Документ ${i + 1}` : 'Документ';
                  return (
                    <div key={`doc-${i}`}>
                      <KV label={docLabel} value={dash(doc.documentType)} />
                      <KV label="Серия / номер" value={dash(seriesNo)} />
                      <KV label="Кем выдан" value={dash(doc.issuedBy)} />
                      <KV label="Дата выдачи" value={dash(doc.issuedDate)} />
                      {doc.issuingCountry && <KV label="Страна" value={dash(doc.issuingCountry)} />}
                    </div>
                  );
                })}
                <KV label="Статус" value={statusVal} />
                <KV label="Проверено" value={fmtLast(row.pdSyncedAt)} />
              </>
            );
          })()}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Финансы и тариф</h4>
            <button className={styles.btn} style={{ padding: '4px 10px', fontSize: 12, minHeight: 0 }} disabled={busy || !accountId} onClick={() => setConnectKind('tariff')}>
              Сменить тариф
            </button>
          </div>
          <KV label="Начисления" value={d?.charges ? fmtMoney(d.charges.amount) : fmtMoney(row.chargesAmount)} />
          <KV label="Тариф" value={dash(d?.tariff.name ?? row.tariffName)} />
          <KV label="Абонентская плата" value={d?.tariff.fee?.amount != null ? `${fmtMoney(d.tariff.fee.amount)}/мес` : '—'} />
          {(d?.packages ?? []).length > 0 && (
            <KV label="Пакеты" value={(d?.packages ?? []).map(fmtPackage).join(' · ')} />
          )}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Подключённые услуги ({d?.services.length ?? row.servicesCount})</h4>
            <button className={st.plusBtn} title="Подключить услугу" aria-label="Подключить услугу" disabled={busy || !accountId} onClick={() => setConnectKind('service')}>+</button>
          </div>
          {details.isLoading ? <p className={styles.hint}>Загрузка…</p> : serviceList(sortPaidFirst(d?.services ?? []), 'service', 'remove', 'Услуг нет — обновите данные, если список пуст ошибочно')}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Блокировки ({d?.blocks.length ?? 0})</h4>
            <button className={st.plusBtn} title="Подключить блокировку" aria-label="Подключить блокировку" disabled={busy || !accountId} onClick={() => setConnectKind('block')}>+</button>
          </div>
          {details.isLoading ? <p className={styles.hint}>Загрузка…</p> : serviceList(d?.blocks ?? [], 'block', 'remove', 'Блокировок нет')}
        </div>

        {((d?.payments ?? []).length > 0 || (d?.forwarding ?? []).length > 0 || d?.roaming || (d?.deliveryMethod ?? []).length > 0) && (
          <div className={st.section}>
            <div className={st.sectionHead}><h4 className={st.sectionTitle}>Прочее</h4></div>
            {(d?.payments ?? []).slice(0, 5).map((p, i) => (
              <KV key={`pay-${i}`} label={`Пополнение ${fmtLast(p.date)}`} value={`${fmtMoney(p.amount)}${p.method ? ` · ${p.method}` : ''}`} />
            ))}
            {(d?.forwarding ?? []).map((f, i) => (
              <KV key={`fw-${i}`} label={`Переадресация ${(f.forwardingType && FORWARDING_TYPE_LABELS[f.forwardingType]) ?? f.forwardingType ?? ''}`} value={dash(f.forwardingAddress)} />
            ))}
            {d?.roaming && <KV label="Роуминг" value={d.roaming.isInternational ? `международный (${dash(d.roaming.countryName ?? d.roaming.countryId)})` : 'нет'} />}
            {(d?.deliveryMethod ?? []).map((dm, i) => (
              <KV key={`dm-${i}`} label="Доставка счетов" value={`${dash(dm.method)}${dm.address ? ` · ${dm.address}` : ''}`} />
            ))}
          </div>
        )}

        </>)}

        {view === 'usage' && (
          <div className={st.section}>
            <div className={st.sectionHead}>
              <h4 className={st.sectionTitle}>Использование SIM — детальная выписка</h4>
              <span className={st.usageControls}>
                <select
                  className={st.monthSelect}
                  value={month}
                  onChange={e => { setMonth(e.target.value); setUsageDate(''); setShowDetail(false); }}
                >
                  {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <select
                  className={st.monthSelect}
                  value={usageDate ? usageDate.slice(8) : ''}
                  onChange={e => { setUsageDate(e.target.value ? `${month}-${e.target.value}` : ''); setShowDetail(false); }}
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
            {usage.data?.rows && (
              usage.data.rows.length === 0
                ? <p className={styles.hint}>{usageDate ? `За ${usageDate} событий нет.` : 'За выбранный месяц событий нет.'}</p>
                : (
                  <>
                    <div className={st.usageStats}>
                      {USAGE_GROUP_ORDER.map(k => {
                        const g = usageSummary.get(k);
                        if (!g || (g.count === 0 && g.amount === 0)) return null;
                        return (
                          <div key={k} className={st.usageStat} data-tooltip={usageTooltip(g)}>
                            <span className={st.usageStatLabel}>{USAGE_GROUP_LABELS[k]}</span>
                            <span className={st.usageStatValue}>{usageGroupValue(g)}</span>
                            <span className={st.usageStatSub}>{usageGroupSub(g)}</span>
                          </div>
                        );
                      })}
                      <div className={`${st.usageStat} ${st.usageStatTotal}`}>
                        <span className={st.usageStatLabel}>Итого</span>
                        <span className={st.usageStatValue}>{fmtMoney(usage.data.total ?? 0)}</span>
                        <span className={st.usageStatSub}>{usage.data.rows.length} событий за {usageDate || 'месяц'}</span>
                      </div>
                    </div>

                    <button
                      className={st.itemBtn}
                      style={{ width: '100%', marginTop: 10 }}
                      onClick={() => setShowDetail(v => !v)}
                    >
                      {showDetail ? '▴ Скрыть детализацию' : `▾ Детализация (${usage.data.rows.length})`}
                    </button>

                    {showDetail && (<>
                      <ul className={st.list} style={{ marginTop: 8 }}>
                        {usage.data.rows.slice(0, USAGE_ROWS_CAP).map((u, i) => (
                          <li key={`u-${i}`} className={st.listItem}>
                            <span className={st.usageDate}>{fmtLast(u.date)}</span>
                            <span className={st.listName}>
                              {u.label ?? u.networkEvent ?? '—'}
                              {(u.peerName || u.peer) && (
                                <> · {u.direction === 'in' ? 'от ' : u.direction === 'out' ? '→ ' : ''}
                                  {u.peerName
                                    ? <>{u.peerName}<span className={st.usagePeerNum}> ({fmtPhone(u.peer)})</span></>
                                    : fmtPhone(u.peer)}
                                </>
                              )}
                            </span>
                            <span className={st.listPrice}>{fmtUnits(u.units, u.unitCode)}</span>
                            <span className={st.usageAmount}>{u.amount > 0 ? fmtMoney(u.amount) : ''}</span>
                          </li>
                        ))}
                      </ul>
                      {usage.data.rows.length > USAGE_ROWS_CAP && (
                        <p className={styles.hint}>Показаны первые {USAGE_ROWS_CAP} из {usage.data.rows.length} событий.</p>
                      )}
                    </>)}
                  </>
                )
            )}
          </div>
        )}

        <div className={st.drawerFooter}>
          <span className={st.capturedAt}>
            {d?.capturedAt ? `данные от ${fmtLast(d.capturedAt)}` : 'данные ещё не выгружались'}
          </span>
        </div>

        {pdOpen && <PersonalDataModal msisdn={msisdn} onClose={() => setPdOpen(false)} />}
        {connectKind && accountId && (
          <ConnectModal msisdn={msisdn} accountId={accountId} kind={connectKind} onClose={() => setConnectKind(null)} />
        )}
      </div>
    </div>
  );
};
