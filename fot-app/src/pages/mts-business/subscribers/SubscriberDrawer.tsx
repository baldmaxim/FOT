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
import type { IMtsSubscriberRow } from '../../../services/mtsBusinessSubscribersService';
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
  const [editLink, setEditLink] = useState(false); // редактирование привязки к сотруднику (карандаш)
  const [connectKind, setConnectKind] = useState<ConnectKind | null>(null); // модалка «+» / смены тарифа
  const usage = useMtsBusinessSubscriberUsage(msisdn, month, usageDate, view === 'usage');

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
            value={row.employeeFullName
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
              : 'не привязан'}
          />
          {(row.employeeId == null || editLink) && (
            <div className={styles.actions} style={{ marginTop: 8, alignItems: 'center' }}>
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
            </div>
          )}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Персональные данные</h4>
            <PersonalDataStatusBadge status={row.pdStatus} />
          </div>
          <KV label="ФИО по данным МТС" value={dash(row.mtsFio)} />
          <KV label="Статус" value={row.pdStatus ? (PD_STATUS_LABELS[row.pdStatus] ?? row.pdStatus) : 'не проверено — обновите данные'} />
          <KV label="Проверено" value={fmtLast(row.pdSyncedAt)} />
          <p className={styles.hint}>
            Паспортные данные хранятся в зашифрованном виде и не отображаются. Внесение/изменение уходит в МТС;
            пользователь номера подтверждает данные через Госуслуги (придёт SMS).
          </p>
          <div className={styles.actions} style={{ marginTop: 4 }}>
            <button className={styles.btnSecondary} onClick={() => setPdOpen(true)}>Внести / изменить</button>
          </div>
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Финансы и тариф</h4>
            <button className={st.itemBtn} disabled={busy || !accountId} onClick={() => setConnectKind('tariff')}>
              Сменить тариф
            </button>
          </div>
          <KV label="Начисления" value={d?.charges ? fmtMoney(d.charges.amount) : fmtMoney(row.chargesAmount)} />
          <KV label="Тариф" value={dash(d?.tariff.name ?? row.tariffName)} />
          <KV label="Абонплата" value={d?.tariff.fee?.amount != null ? `${fmtMoney(d.tariff.fee.amount)}/мес` : '—'} />
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
                  onChange={e => { setMonth(e.target.value); setUsageDate(''); }}
                >
                  {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <input
                  className={st.monthSelect}
                  type="date"
                  value={usageDate}
                  onChange={e => setUsageDate(e.target.value)}
                  title="Показать использование за конкретную дату"
                />
                {usageDate && (
                  <button className={st.itemBtn} onClick={() => setUsageDate('')}>За месяц</button>
                )}
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
                    <KV label={`Событий за ${usageDate || 'месяц'}: ${usage.data.rows.length}`} value={<b>итого {fmtMoney(usage.data.total ?? 0)}</b>} />
                    <ul className={st.list}>
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
                  </>
                )
            )}
          </div>
        )}

        <div className={st.drawerFooter}>
          <button className={styles.btn} disabled={busy} onClick={() => { void onRefresh(); }}>
            {refresh.isPending ? 'Обновление…' : 'Обновить данные из МТС'}
          </button>
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
