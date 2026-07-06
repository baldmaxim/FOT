import { type FC, type ReactNode, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useMtsBusinessSubscriberDetails,
  useMtsBusinessSubscriberAvailable,
  useRefreshMtsBusinessSubscriber,
  useChangeMtsBusinessTariff,
} from '../../../hooks/useMtsBusinessSubscribers';
import { useMtsBusinessSubscriberExpenses } from '../../../hooks/useMtsBusinessSubscriberData';
import { useModifyMtsBusinessService } from '../../../hooks/useMtsBusinessActionsData';
import { useSetMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import type { IMtsSubscriberRow } from '../../../services/mtsBusinessSubscribersService';
import type { IMtsSubServiceItem } from '../../../services/mtsBusinessSubscriberService';
import { isMtsUnavailable } from '../../../services/mtsBusinessTypes';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { EmployeeFioPicker } from '../../mts/EmployeeFioPicker';
import {
  errText, fmtDur, fmtLast, fmtMoney, fmtPackage,
  EXPENSE_CATEGORY_LABELS, FORWARDING_TYPE_LABELS,
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
  const [showAvailable, setShowAvailable] = useState(false);
  const available = useMtsBusinessSubscriberAvailable(msisdn, showAvailable);
  const refresh = useRefreshMtsBusinessSubscriber();
  const modify = useModifyMtsBusinessService();
  const changeTariff = useChangeMtsBusinessTariff();
  const setMap = useSetMtsBusinessNumberMap();
  const months = useMemo(() => lastMonths(6), []);
  const [month, setMonth] = useState(months[0].value);
  const expenses = useMtsBusinessSubscriberExpenses(msisdn, month, true);
  const [pdOpen, setPdOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const accountId = details.data?.accountId ?? row.accountId ?? '';
  const busy = modify.isPending || changeTariff.isPending || refresh.isPending || setMap.isPending;

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

  const onChangeTariff = async (tariffId: string | null, name: string | null): Promise<void> => {
    if (!tariffId) return;
    if (!window.confirm(`Перевести номер ${msisdn} на тариф «${name ?? tariffId}»? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await changeTariff.mutateAsync({ accountId: accountId || undefined, msisdn, externalID: tariffId });
      setMsg({ ok: true, text: `Заявка на смену тарифа отправлена (eventId ${r.eventId})` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка смены тарифа (возможно нужен 2FA)') });
    }
  };

  const onLink = async (employeeId: number | null): Promise<void> => {
    setMsg(null);
    try {
      await setMap.mutateAsync({ msisdn, employeeId });
      setMsg({ ok: true, text: employeeId != null ? 'Привязка сохранена' : 'Привязка снята' });
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
            <h3 className={st.drawerTitle}>{msisdn}</h3>
            <p className={st.drawerSub}>
              {[row.employeeFullName ?? row.mtsFio ?? row.mtsComment, row.accountLabel, row.tariffName].filter(Boolean).join(' · ') || 'Абонент МТС'}
            </p>
          </div>
          <button className={st.drawerClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

        <div className={st.section}>
          <div className={st.sectionHead}><h4 className={st.sectionTitle}>Абонент</h4><PersonalDataStatusBadge status={row.pdStatus} /></div>
          <KV label="ФИО в МТС" value={dash(row.mtsFio)} />
          <KV label="Комментарий МТС" value={dash(row.mtsComment)} />
          <KV label="Лицевой счёт" value={dash(row.accountLabel)} />
          <KV
            label="Сотрудник ФОТ"
            value={row.employeeFullName
              ? `${row.employeeFullName}${row.employeeTabNumber ? ` (таб. ${row.employeeTabNumber})` : ''}`
              : 'не привязан'}
          />
          <div className={styles.actions} style={{ marginTop: 8, alignItems: 'center' }}>
            <EmployeeFioPicker
              disabled={busy}
              placeholder={row.employeeId != null ? 'Сменить сотрудника…' : 'Привязать по ФИО…'}
              onSelect={id => { void onLink(id); }}
            />
            {row.employeeId != null && (
              <button className={styles.btnSecondary} disabled={busy} onClick={() => { void onLink(null); }}>Снять</button>
            )}
            <button className={styles.btnSecondary} onClick={() => setPdOpen(true)}>Персданные</button>
          </div>
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}><h4 className={st.sectionTitle}>Финансы и тариф</h4></div>
          <KV label="Баланс ЛС" value={d?.balance ? `${fmtMoney(d.balance.amount)} (${fmtLast(d.balance.capturedAt)})` : fmtMoney(row.balance)} />
          <KV label="Начисления" value={d?.charges ? fmtMoney(d.charges.amount) : fmtMoney(row.chargesAmount)} />
          <KV label="Тариф" value={dash(d?.tariff.name ?? row.tariffName)} />
          <KV label="Абонплата" value={d?.tariff.fee?.amount != null ? `${fmtMoney(d.tariff.fee.amount)}/мес` : '—'} />
          {(d?.packages ?? []).length > 0 && (
            <KV label="Пакеты" value={(d?.packages ?? []).map(fmtPackage).join(' · ')} />
          )}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}><h4 className={st.sectionTitle}>Подключённые услуги ({d?.services.length ?? row.servicesCount})</h4></div>
          {details.isLoading ? <p className={styles.hint}>Загрузка…</p> : serviceList(d?.services ?? [], 'service', 'remove', 'Платных услуг нет — обновите данные, если список пуст ошибочно')}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}><h4 className={st.sectionTitle}>Блокировки ({d?.blocks.length ?? 0})</h4></div>
          {details.isLoading ? <p className={styles.hint}>Загрузка…</p> : serviceList(d?.blocks ?? [], 'block', 'remove', 'Блокировок нет')}
        </div>

        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Подключение услуг и смена тарифа</h4>
            {!showAvailable && (
              <button className={st.itemBtn} onClick={() => setShowAvailable(true)}>Загрузить доступные</button>
            )}
          </div>
          {!showAvailable && <p className={styles.hint}>Каталог доступного запрашивается из МТС по кнопке (3 живых запроса).</p>}
          {showAvailable && available.isLoading && <p className={styles.hint}>Загрузка каталога из МТС…</p>}
          {showAvailable && available.isError && <p className={styles.err}>Не удалось загрузить каталог.</p>}
          {showAvailable && available.data && (
            <>
              <h5 className={st.sectionTitle} style={{ margin: '6px 0' }}>Доступные услуги</h5>
              {isMtsUnavailable(available.data.services)
                ? <UnavailableNotice compact />
                : 'data' in available.data.services
                  ? serviceList(available.data.services.data, 'service', 'add', 'Нет доступных услуг')
                  : <p className={styles.err}>Ошибка загрузки</p>}
              <h5 className={st.sectionTitle} style={{ margin: '10px 0 6px' }}>Доступные блокировки</h5>
              {isMtsUnavailable(available.data.blocks)
                ? <UnavailableNotice compact />
                : 'data' in available.data.blocks
                  ? serviceList(available.data.blocks.data, 'block', 'add', 'Нет доступных блокировок')
                  : <p className={styles.err}>Ошибка загрузки</p>}
              <h5 className={st.sectionTitle} style={{ margin: '10px 0 6px' }}>Тарифы для перехода</h5>
              {isMtsUnavailable(available.data.tariffs)
                ? <UnavailableNotice compact />
                : 'data' in available.data.tariffs
                  ? (available.data.tariffs.data.length === 0
                    ? <p className={styles.hint}>Нет доступных тарифов</p>
                    : (
                      <ul className={st.list}>
                        {available.data.tariffs.data.map((t, i) => (
                          <li key={t.tariffId ?? `t-${i}`} className={st.listItem}>
                            <span className={st.listName}>{dash(t.name ?? t.tariffId)}</span>
                            <span className={st.listPrice}>{t.price != null ? `${fmtMoney(t.price)}/мес` : ''}</span>
                            <button className={st.itemBtn} disabled={busy || !t.tariffId} onClick={() => { void onChangeTariff(t.tariffId, t.name); }}>
                              Перейти
                            </button>
                          </li>
                        ))}
                      </ul>
                    ))
                  : <p className={styles.err}>Ошибка загрузки</p>}
            </>
          )}
        </div>

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

        <div className={st.drawerFooter}>
          <button className={styles.btn} disabled={busy} onClick={() => { void onRefresh(); }}>
            {refresh.isPending ? 'Обновление…' : 'Обновить данные из МТС'}
          </button>
          <span className={st.capturedAt}>
            {d?.capturedAt ? `данные от ${fmtLast(d.capturedAt)}` : 'данные ещё не выгружались'}
          </span>
        </div>

        {pdOpen && <PersonalDataModal msisdn={msisdn} onClose={() => setPdOpen(false)} />}
      </div>
    </div>
  );
};
