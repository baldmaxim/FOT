import { type FC, type ReactNode, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useMtsBusinessSubscriberDetails,
  useMtsBusinessSubscriberUsage,
  useRefreshMtsBusinessSubscriber,
} from '../../../hooks/useMtsBusinessSubscribers';
import { useModifyMtsBusinessService } from '../../../hooks/useMtsBusinessActionsData';
import { useSetMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import type { IMtsSubscriberRow, IMtsSubscriberSyncResult } from '../../../services/mtsBusinessSubscribersService';
import type { IMtsSubServiceItem } from '../../../services/mtsBusinessSubscriberService';
import { ConnectModal, type ConnectKind } from './ConnectModal';
import { SubscriberForwardingModal } from './SubscriberForwardingModal';
import { UsageTab } from './UsageTab';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { EmployeeFioPicker } from '../../mts/EmployeeFioPicker';
import {
  type IUsageGroup,
  type UsageGroupKey,
  USAGE_GROUP_LABELS,
  USAGE_GROUP_ORDER,
  fmtUnits,
  usageGroupsFromTotals,
  usageTooltip,
} from '../usageSummary';
import {
  errText, fmtDur, fmtLast, fmtMoney, fmtPackage, packageHasData, fmtPhone, lastMonths,
  FORWARDING_TYPE_LABELS, PD_STATUS_LABELS,
} from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; warn?: boolean; text: string } | null;

const SYNC_SECTION_LABELS: Record<string, string> = {
  personal_data: 'Персональные данные',
  bill_plan: 'Тариф',
  tariff_fee: 'Абонплата',
  product_services: 'Услуги',
  connected_blocks: 'Блокировки',
  charges: 'Начисления',
  forwarding: 'Переадресация',
  roaming: 'Роуминг',
  delivery_method: 'Доставка счетов',
  payments: 'Платежи',
  validity_msisdn: 'Остатки пакетов',
};

const sectionLabel = (section: string): string => SYNC_SECTION_LABELS[section] ?? section;

const formatSyncResultMsg = (r: IMtsSubscriberSyncResult): Msg => {
  const parts = [`Обновлено секций: ${r.stored} из ${r.sections}`];
  if (r.unavailable) parts.push(`не подключено в тарифе: ${r.unavailable}`);

  const failedNames = r.errors.filter(e => e.kind === 'failed').map(e => sectionLabel(e.section));
  const transientNames = r.errors.filter(e => e.kind === 'transient').map(e => sectionLabel(e.section));

  if (r.failed > 0) {
    const errPart = failedNames.length ? failedNames.join(', ') : `${r.failed}`;
    return { ok: false, text: `${parts.join(', ')}, ошибки: ${errPart}` };
  }
  if (r.transient > 0) {
    const names = transientNames.join(', ');
    return {
      ok: true,
      warn: true,
      text: `${parts.join(', ')}. ${names}: МТС временно недоступен — повторите позже`,
    };
  }
  return { ok: true, text: parts.join(', ') };
};

const dash = (v: string | number | null | undefined): string => (v == null || v === '' ? '—' : String(v));

/** Дата ПДн из МТС (ISO/«YYYY-MM-DDThh:mm…») → «DD.MM.YYYY»; иной формат — как есть. */
const fmtPdDate = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v;
};

/** Платные услуги сверху (по убыванию абонплаты), затем бесплатные. */
const sortPaidFirst = (items: IMtsSubServiceItem[]): IMtsSubServiceItem[] =>
  [...items].sort((a, b) => (b.monthlyAmount ?? 0) - (a.monthlyAmount ?? 0));

const KV: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <div className={st.kv}>
    <span className={st.kvLabel}>{label}</span>
    <span className={st.kvVal}>{value}</span>
  </div>
);

/**
 * Объём группы в её собственных единицах: звонки — длительность, интернет — МБ,
 * СМС — штуки, прочее — объёма нет (только расход). Те же единицы, что у плиток
 * «Использования» и ЛК (usageGroupValue), чтобы не было «Интернет 284» без единиц.
 */
const statsVolume = (g: IUsageGroup): string => {
  if (g.key === 'calls') return fmtDur(g.seconds);
  if (g.key === 'internet') return fmtUnits(g.bytes, 'BYTE');
  if (g.key === 'sms') return `${g.count} шт`;
  return '—';
};

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
  // Статистика и вкладка «Использование» читают ОДИН запрос (тот же queryKey —
  // React Query отдаёт из кэша) и один серверный агрегат: цифры совпадают
  // с «Использованием» и с ЛК сотрудника по построению.
  const usage = useMtsBusinessSubscriberUsage(msisdn, month, '', true);
  const statsGroups = useMemo(
    () => (usage.data?.totals ? usageGroupsFromTotals(usage.data.totals, usage.data.rows ?? []) : new Map<UsageGroupKey, IUsageGroup>()),
    [usage.data],
  );
  const statsEvents = useMemo(
    () => [...statsGroups.values()].reduce((sum, g) => sum + g.count, 0),
    [statsGroups],
  );
  const monthLabel = months.find(m => m.value === month)?.label ?? month;
  const [pdOpen, setPdOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [view, setView] = useState<'main' | 'usage'>('main');
  const [editLink, setEditLink] = useState(false); // редактирование привязки к сотруднику (карандаш)
  const [connectKind, setConnectKind] = useState<ConnectKind | null>(null); // модалка «+» / смены тарифа
  const [fwdOpen, setFwdOpen] = useState(false); // модалка переадресации

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
      setMsg(formatSyncResultMsg(r));
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

        {msg && <p className={msg.warn ? styles.warn : msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

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
            <h4 className={st.sectionTitle}>Статистика за {monthLabel}</h4>
            <select className={st.monthSelect} value={month} onChange={e => setMonth(e.target.value)}>
              {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          {usage.isLoading && <p className={styles.hint}>Загрузка статистики…</p>}
          {usage.isError && <p className={styles.err}>Не удалось загрузить статистику.</p>}
          {usage.data?.unavailable && <UnavailableNotice message="Детализация не активирована для этого лицевого счёта." />}

          {usage.data?.totals && (usage.data.totals.groups.some(g => g.count > 0)
            ? (
              <table className={st.statsTable}>
                <thead>
                  <tr>
                    <th>Категория</th>
                    <th>Событий</th>
                    <th>Объём</th>
                    <th>Расход</th>
                  </tr>
                </thead>
                <tbody>
                  {USAGE_GROUP_ORDER.map(k => {
                    const g = statsGroups.get(k);
                    if (!g || (g.count === 0 && g.amount === 0)) return null;
                    return (
                      <tr key={k}>
                        <td>{USAGE_GROUP_LABELS[k]}</td>
                        <td className={st.numCell}>{g.count}</td>
                        <td className={st.numCell} title={k === 'calls' ? usageTooltip(g) : undefined}>
                          {statsVolume(g)}
                        </td>
                        <td className={st.numCell}>{g.amount > 0 ? fmtMoney(g.amount) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Итого</td>
                    <td className={st.numCell}>{statsEvents}</td>
                    <td className={st.numCell}>—</td>
                    <td className={st.numCell}><b>{fmtMoney(usage.data.total ?? 0)}</b></td>
                  </tr>
                </tfoot>
              </table>
            )
            : <p className={styles.hint}>За выбранный месяц событий нет.</p>
          )}

          <KV label="За всё время (звонки)" value={`${row.calls} · ${fmtDur(row.totalSeconds)}`} />
          <KV label="Последний звонок" value={fmtLast(row.lastCallAt)} />
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
                <KV label="Дата рождения" value={dash(fmtPdDate(pd.birthDate))} />
                {pd.documents.length === 0 && <KV label="Документ" value="—" />}
                {pd.documents.map((doc, i) => {
                  const seriesNo = [doc.documentSeries, doc.documentNo].filter(Boolean).join(' ') || null;
                  const docLabel = pd.documents.length > 1 ? `Документ ${i + 1}` : 'Документ';
                  return (
                    <div key={`doc-${i}`}>
                      <KV label={docLabel} value={dash(doc.documentType)} />
                      <KV label="Серия / номер" value={dash(seriesNo)} />
                      <KV label="Кем выдан" value={dash(doc.issuedBy)} />
                      <KV label="Дата выдачи" value={dash(fmtPdDate(doc.issuedDate))} />
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
          <KV label="Начисления (месяц)" value={d?.charges ? fmtMoney(d.charges.amount) : fmtMoney(row.chargesAmount)} />
          <KV label="Тариф" value={dash(d?.tariff.name ?? row.tariffName)} />
          <KV label="Абонентская плата" value={d?.tariff.fee?.amount != null ? `${fmtMoney(d.tariff.fee.amount)}/мес` : '—'} />
          {(() => {
            const lines = [...new Set((d?.packages ?? []).filter(packageHasData).map(fmtPackage))];
            return lines.length > 0
              ? lines.map((t, i) => <KV key={`pkg-${i}`} label={i === 0 ? 'Пакеты' : ''} value={t} />)
              : null;
          })()}
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

        {/* Переадресация — своя секция (видна всегда, даже когда правил нет):
            админ должен видеть, что звонки уходят на другой номер, и уметь снять
            правило за сотрудника (напр. у уволенного). */}
        <div className={st.section}>
          <div className={st.sectionHead}>
            <h4 className={st.sectionTitle}>Переадресация</h4>
            <button
              className={st.itemBtn}
              disabled={busy || !accountId || details.isLoading}
              onClick={() => setFwdOpen(true)}
            >
              Изменить
            </button>
          </div>
          {details.isLoading ? <p className={styles.hint}>Загрузка…</p> : (d?.forwarding ?? []).length === 0 ? (
            <p className={styles.hint}>Не настроена — звонки приходят только на эту SIM.</p>
          ) : (
            (d?.forwarding ?? []).map((f, i) => (
              <KV
                key={`fw-${i}`}
                label={(f.forwardingType && FORWARDING_TYPE_LABELS[f.forwardingType]) ?? f.forwardingType ?? 'Правило'}
                value={`${dash(f.forwardingAddress)}${f.forwardingType === 'CFNRY' && f.noReplyTimer ? ` · через ${f.noReplyTimer} сек` : ''}`}
              />
            ))
          )}
        </div>

        {(d?.roaming || (d?.deliveryMethod ?? []).length > 0) && (
          <div className={st.section}>
            <div className={st.sectionHead}><h4 className={st.sectionTitle}>Прочее</h4></div>
            {d?.roaming && <KV label="Роуминг" value={d.roaming.isInternational ? `международный (${dash(d.roaming.countryName ?? d.roaming.countryId)})` : 'нет'} />}
            {(d?.deliveryMethod ?? []).map((dm, i) => (
              <KV key={`dm-${i}`} label="Доставка счетов" value={`${dash(dm.method)}${dm.address ? ` · ${dm.address}` : ''}`} />
            ))}
          </div>
        )}

        </>)}

        {view === 'usage' && (
          <UsageTab msisdn={msisdn} month={month} months={months} setMonth={setMonth} />
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
        {fwdOpen && accountId && (
          <SubscriberForwardingModal
            msisdn={msisdn}
            accountId={accountId}
            rules={d?.forwarding ?? []}
            onClose={() => setFwdOpen(false)}
          />
        )}
      </div>
    </div>
  );
};
