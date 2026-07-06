import { type FC, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  useMtsBusinessAccounts,
  useMtsBusinessImportedNumbers,
  useCreateMtsBusinessAccount,
  useUpdateMtsBusinessAccount,
  useDeleteMtsBusinessAccount,
  useFetchSyncMtsBusinessDetalization,
  useUploadMtsBusinessDetalization,
  useSetMtsBusinessNumberMap,
  useAutoLinkMtsBusinessNumberMap,
} from '../../hooks/useMtsBusinessData';
import {
  useMtsBusinessActions,
  useMtsBusinessBudgetRules,
  useModifyMtsBusinessService,
  useAddMtsBusinessBudgetRule,
  useRemoveMtsBusinessBudgetRule,
} from '../../hooks/useMtsBusinessActionsData';
import { mtsBusinessService, type IMtsBusinessAccount } from '../../services/mtsBusinessService';
import type { IMtsBusinessBudgetRule } from '../../services/mtsBusinessActionsService';
import { EmployeeFioPicker } from '../mts/EmployeeFioPicker';
import { OverviewSection } from './OverviewSection';
import { SubscriberCardModal } from './SubscriberCardModal';
import { errText, toISODate, fmtDur, fmtLast, ACTION_TYPE_LABELS } from './mtsBusinessFormat';
import styles from './MtsBusinessPage.module.css';

const STATUS_BADGE: Record<string, { cls: (typeof styles)[keyof typeof styles]; label: string }> = {
  completed: { cls: styles.badgeOk, label: 'готово' },
  in_progress: { cls: styles.badgeWait, label: 'в обработке' },
  faulted: { cls: styles.badgeErr, label: 'ошибка' },
  unknown: { cls: styles.badgeMuted, label: '—' },
};

type Msg = { ok: boolean; text: string } | null;

// ================= Модалка аккаунта =================
const AccountModal: FC<{ account: IMtsBusinessAccount | null; onClose: () => void }> = ({ account, onClose }) => {
  const createM = useCreateMtsBusinessAccount();
  const updateM = useUpdateMtsBusinessAccount();
  const editing = Boolean(account);
  const [label, setLabel] = useState(account?.label ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '');
  const [login, setLogin] = useState(account?.login ?? '');
  const [password, setPassword] = useState('');
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? '');
  const [rateLimitPerMin, setRateLimitPerMin] = useState(String(account?.rateLimitPerMin ?? 60));
  const [msg, setMsg] = useState<Msg>(null);
  const overlay = useOverlayDismiss(onClose);

  const busy = createM.isPending || updateM.isPending;
  const onSave = async (): Promise<void> => {
    setMsg(null);
    const rateLimit = Math.max(1, Number.parseInt(rateLimitPerMin, 10) || 60);
    try {
      if (account) {
        await updateM.mutateAsync({
          id: account.id,
          data: {
            label: label.trim(), accountNumber: accountNumber.trim() || null, login: login.trim(),
            baseUrl: baseUrl.trim() || null, rateLimitPerMin: rateLimit,
            ...(password.trim() ? { password: password.trim() } : {}),
          },
        });
      } else {
        await createM.mutateAsync({
          label: label.trim(), accountNumber: accountNumber.trim() || undefined,
          login: login.trim(), password: password.trim(), baseUrl: baseUrl.trim() || undefined,
          rateLimitPerMin: rateLimit,
        });
      }
      onClose();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка сохранения (возможно нужен 2FA)') });
    }
  };

  return (
    <div className={styles.modalOverlay} {...overlay}>
      <div className={styles.modal}>
        <h3 className={styles.cardTitle}>{editing ? 'Изменить аккаунт' : 'Новый аккаунт МТС Бизнес'}</h3>
        <div className={styles.field}>
          <label className={styles.label}>Название</label>
          <input className={styles.input} type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="СУ-10 основной" autoFocus />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт (ЛС)</label>
          <input className={styles.input} type="text" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="277308204324" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Логин API</label>
          <input className={styles.input} type="text" autoComplete="off" value={login} onChange={e => setLogin(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Пароль API {editing && '(пусто — не менять)'}</label>
          <input className={styles.input} type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Base URL (необязательно)</label>
          <input className={styles.input} type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.mts.ru/b2b/v1" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лимит запросов/мин (тариф пакета — 60 или 300)</label>
          <input className={styles.input} type="number" min={1} value={rateLimitPerMin} onChange={e => setRateLimitPerMin(e.target.value)} />
        </div>
        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
        <div className={styles.actions}>
          <button className={styles.btn} onClick={onSave} disabled={busy || !label.trim() || !login.trim() || (!editing && !password.trim())}>
            {editing ? 'Сохранить' : 'Добавить'} (2FA)
          </button>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>Отмена</button>
        </div>
      </div>
    </div>
  );
};

// ================= Аккаунты (список название+ЛС, «+» модалка) =================
const AccountsSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const deleteM = useDeleteMtsBusinessAccount();
  const [modal, setModal] = useState<{ open: boolean; account: IMtsBusinessAccount | null }>({ open: false, account: null });
  const [tests, setTests] = useState<Record<string, Msg>>({});
  const rows = accounts.data ?? [];

  const onTest = async (id: string): Promise<void> => {
    setTests(p => ({ ...p, [id]: { ok: false, text: '…' } }));
    try {
      const r = await mtsBusinessService.testAccount(id);
      setTests(p => ({ ...p, [id]: r.ok ? { ok: true, text: 'OK' } : { ok: false, text: r.error || 'Ошибка' } }));
    } catch (e) {
      setTests(p => ({ ...p, [id]: { ok: false, text: errText(e, 'Ошибка') } }));
    }
  };
  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('Удалить аккаунт?')) return;
    try { await deleteM.mutateAsync(id); } catch { /* ignore, 2FA */ }
  };

  return (
    <section className={styles.card}>
      <div className={styles.actions} style={{ justifyContent: 'space-between', marginTop: 0, marginBottom: 8 }}>
        <h2 className={styles.cardTitle} style={{ margin: 0 }}>Аккаунты (API / лицевые счета)</h2>
        <button className={styles.btn} onClick={() => setModal({ open: true, account: null })}>+ Аккаунт</button>
      </div>
      {rows.length === 0 ? (
        <p className={styles.hint}>Нет аккаунтов. Нажмите «+ Аккаунт», чтобы добавить API-доступ по лицевому счёту.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Название</th><th>Лицевой счёт</th><th>Статус</th><th></th></tr></thead>
            <tbody>
              {rows.map(a => {
                const t = tests[a.id];
                return (
                  <tr key={a.id}>
                    <td>{a.label}</td>
                    <td>{a.accountNumber ?? '—'}</td>
                    <td>
                      {a.isActive
                        ? <span className={`${styles.badge} ${styles.badgeOk}`}>активен</span>
                        : <span className={`${styles.badge} ${styles.badgeMuted}`}>выкл</span>}
                      {t && <span className={t.ok ? styles.ok : styles.err} style={{ marginLeft: 6 }}>{t.text}</span>}
                    </td>
                    <td>
                      <button className={styles.btnSecondary} onClick={() => onTest(a.id)}>Проверить</button>{' '}
                      <button className={styles.btnSecondary} onClick={() => setModal({ open: true, account: a })}>Изменить</button>{' '}
                      <button className={styles.btnSecondary} onClick={() => onDelete(a.id)} disabled={deleteM.isPending}>Удалить</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {modal.open && <AccountModal account={modal.account} onClose={() => setModal({ open: false, account: null })} />}
    </section>
  );
};

// ================= Синхронная детализация: автообновление + ручной бэкафилл =================
const SyncSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const fetchSync = useFetchSyncMtsBusinessDetalization();
  const now = useMemo(() => new Date(), []);
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const [accountId, setAccountId] = useState('');
  const [targets, setTargets] = useState('');
  const [dateFrom, setDateFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [dateTo, setDateTo] = useState(toISODate(now));
  const [msg, setMsg] = useState<Msg>(null);

  const onFetch = async (): Promise<void> => {
    setMsg(null);
    const acc = accountId || active[0]?.id;
    if (!acc) { setMsg({ ok: false, text: 'Сначала добавьте аккаунт' }); return; }
    const list = targets.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) { setMsg({ ok: false, text: 'Укажите хотя бы один номер 7XXXXXXXXXX' }); return; }
    try {
      const r = await fetchSync.mutateAsync({ accountId: acc, msisdns: list, dateFrom, dateTo });
      const failedText = r.failedNumbers.length ? `, ошибки по номерам: ${r.failedNumbers.join(', ')}` : '';
      setMsg({ ok: r.failedNumbers.length === 0, text: `Разобрано звонков: ${r.parsed}, добавлено: ${r.inserted}, пропущено (дубли): ${r.skipped}${failedText}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка загрузки детализации') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Детализация звонков</h2>
      <p className={styles.hint}>
        Автообновление — раз в сутки, без участия: за уже известные номера каждого лицевого счёта данные подтягиваются
        сами (учитывается тариф пакета запросов). Ниже — разовая ручная загрузка за произвольный период
        (например, для нового номера или досрочной проверки).
      </p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Аккаунт</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">{active.length ? '— выберите —' : 'нет аккаунтов'}</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Период с</label>
          <input className={styles.input} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>по</label>
          <input className={styles.input} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Номера 7XXXXXXXXXX (через запятую)</label>
        <textarea className={styles.textarea} value={targets} onChange={e => setTargets(e.target.value)} placeholder="79001234567, 79007654321" />
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onFetch} disabled={fetchSync.isPending || active.length === 0}>Загрузить за период (2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

// ================= Загрузка детализации =================
const UploadSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const upload = useUploadMtsBusinessDetalization();
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const onUpload = async (): Promise<void> => {
    setMsg(null);
    if (!file) { setMsg({ ok: false, text: 'Выберите файл (XLS/XML)' }); return; }
    try {
      const r = await upload.mutateAsync({ file, accountId: accountId || undefined, msisdn: msisdn.trim() || undefined });
      const extra = r.autoLinked ? `, автопривязано к сотрудникам: ${r.autoLinked}` : '';
      setMsg({ ok: true, text: `Разобрано: ${r.parsed}, добавлено: ${r.inserted}, пропущено (дубли): ${r.skipped}${extra}` });
      setFile(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка обработки файла') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Загрузка детализации (XLS/XML)</h2>
      <p className={styles.hint}>Файл-отчёт из МТС (Excel или XML). Свой номер берётся из файла; привязка к лицевому счёту — для дашборда по ЛС.</p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Файл</label>
          <input className={styles.input} type="file" accept=".xls,.xlsx,.xml,application/vnd.ms-excel,text/xml,application/xml"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт (аккаунт)</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">— не привязывать —</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Номер (если не в файле)</label>
          <input className={styles.input} type="text" value={msisdn} onChange={e => setMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onUpload} disabled={upload.isPending || !file}>Загрузить (2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

// ================= Импортированные номера: привязка к сотрудникам =================
const NumberMapSection: FC = () => {
  const imported = useMtsBusinessImportedNumbers(true);
  const setMap = useSetMtsBusinessNumberMap();
  const autoLink = useAutoLinkMtsBusinessNumberMap();
  const [manualMsisdn, setManualMsisdn] = useState('');
  const [cardMsisdn, setCardMsisdn] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const rows = imported.data ?? [];

  const link = async (msisdn: string, employeeId: number | null): Promise<void> => {
    setMsg(null);
    try {
      await setMap.mutateAsync({ msisdn, employeeId });
      setMsg({ ok: true, text: employeeId != null ? 'Привязка сохранена' : 'Привязка снята' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка сохранения привязки (возможно нужен 2FA)') });
    }
  };

  const onAutoLink = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await autoLink.mutateAsync();
      setMsg({ ok: true, text: `Проверено непривязанных с ФИО: ${r.checked}, привязано автоматически: ${r.linked}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка автопривязки (возможно нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.actions} style={{ justifyContent: 'space-between', marginTop: 0, marginBottom: 8 }}>
        <h2 className={styles.cardTitle} style={{ margin: 0 }}>Импортированные номера — привязка к сотрудникам</h2>
        <button className={styles.btnSecondary} onClick={() => { void onAutoLink(); }} disabled={autoLink.isPending}>
          Автосвязать по ФИО (2FA)
        </button>
      </div>
      <p className={styles.hint}>
        Все свои номера из загруженных детализаций. Найдите сотрудника по ФИО в строке номера — его время разговоров
        появится в отчёте «По сотрудникам». «Автосвязать по ФИО» пере-проверяет непривязанные номера с известным ФИО от
        МТС и линкует только при точном однозначном совпадении — спорные случаи остаются для ручной привязки. Сохранение
        требует 2FA.
      </p>
      {imported.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {!imported.isLoading && rows.length === 0 && (
        <p className={styles.hint}>Номеров пока нет — загрузите детализацию в разделе выше.</p>
      )}
      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Номер</th><th>ФИО у МТС</th><th>Звонки</th><th>Время</th><th>Последний звонок</th><th>Сотрудник</th><th>Привязать</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.msisdn ?? `row-${i}`}>
                  <td>
                    {r.msisdn
                      ? <button className={styles.linkBtn} onClick={() => setCardMsisdn(r.msisdn)}>{r.msisdn}</button>
                      : '—'}
                  </td>
                  <td>{r.mtsFio ?? '—'}</td>
                  <td>{r.calls}</td>
                  <td>{fmtDur(r.totalSeconds)}</td>
                  <td>{fmtLast(r.lastCallAt)}</td>
                  <td>
                    {r.employeeFullName
                      ? <>{r.employeeFullName}{r.employeeTabNumber ? ` (таб. ${r.employeeTabNumber})` : ''}</>
                      : <span className={`${styles.badge} ${styles.badgeMuted}`}>не привязан</span>}
                  </td>
                  <td>
                    {r.msisdn != null && (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <EmployeeFioPicker
                          disabled={setMap.isPending}
                          placeholder={r.employeeId != null ? 'Сменить…' : 'Поиск по ФИО…'}
                          onSelect={id => { void link(r.msisdn as string, id); }}
                        />
                        {r.employeeId != null && (
                          <button
                            className={styles.btnSecondary}
                            onClick={() => { void link(r.msisdn as string, null); }}
                            disabled={setMap.isPending}
                          >
                            Снять
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.row} style={{ marginTop: 8 }}>
        <div className={styles.field}>
          <label className={styles.label}>Номер вне списка</label>
          <input className={styles.input} type="text" value={manualMsisdn} onChange={e => setManualMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Сотрудник</label>
          <EmployeeFioPicker
            disabled={setMap.isPending || !manualMsisdn.trim()}
            onSelect={id => {
              void link(manualMsisdn.trim(), id).then(() => setManualMsisdn(''));
            }}
          />
        </div>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
      {cardMsisdn && <SubscriberCardModal msisdn={cardMsisdn} onClose={() => setCardMsisdn(null)} />}
    </section>
  );
};

// ================= Управление услугами/блокировками/бюджетом (Фаза 3) =================
const ActionsSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const imported = useMtsBusinessImportedNumbers(true);
  const actions = useMtsBusinessActions(true);
  const modifyService = useModifyMtsBusinessService();
  const addRule = useAddMtsBusinessBudgetRule();
  const removeRule = useRemoveMtsBusinessBudgetRule();

  const [accountId, setAccountId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [externalID, setExternalID] = useState('');
  const [kind, setKind] = useState<'service' | 'block'>('service');
  const [ruleProductCode, setRuleProductCode] = useState('');
  const [ruleVersionId, setRuleVersionId] = useState('');
  const [ruleLimit, setRuleLimit] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const rules = useMtsBusinessBudgetRules(accountId, msisdn, Boolean(accountId && msisdn));
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const numbers = (imported.data ?? []).filter(r => r.msisdn);

  const onModify = async (mode: 'add' | 'remove'): Promise<void> => {
    setMsg(null);
    if (!accountId || !msisdn || !externalID.trim()) { setMsg({ ok: false, text: 'Укажите лицевой счёт, номер и код услуги/блокировки' }); return; }
    try {
      const r = await modifyService.mutateAsync({ accountId, msisdn, externalID: externalID.trim(), kind, mode });
      setMsg({ ok: true, text: `Заявка отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onAddRule = async (): Promise<void> => {
    setMsg(null);
    if (!accountId || !msisdn || !ruleProductCode.trim() || !ruleVersionId.trim()) { setMsg({ ok: false, text: 'Укажите код и версию правила' }); return; }
    try {
      const r = await addRule.mutateAsync({ accountId, msisdn, productCode: ruleProductCode.trim(), productVersionId: ruleVersionId.trim(), limitValue: ruleLimit.trim() || undefined });
      setMsg({ ok: true, text: `Заявка отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onRemoveRule = async (rule: IMtsBusinessBudgetRule): Promise<void> => {
    if (!accountId || !msisdn || !rule.productCode || !rule.productVersionId) return;
    setMsg(null);
    try {
      const r = await removeRule.mutateAsync({ accountId, msisdn, productCode: rule.productCode, productVersionId: rule.productVersionId });
      setMsg({ ok: true, text: `Заявка на удаление отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Управление услугами, блокировками и бюджетом</h2>
      <p className={styles.hint}>
        Асинхронные операции — статус появится в таблице заявок ниже. Коды услуг (PEXXXX), блокировок (BLXXXX) и правил
        бюджета (CB.RULE.XXXXX) вводятся вручную, как в личном кабинете МТС.
      </p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">— выберите —</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Номер</label>
          <select className={styles.select} value={msisdn} onChange={e => setMsisdn(e.target.value)}>
            <option value="">— выберите —</option>
            {numbers.map(r => (
              <option key={r.msisdn} value={r.msisdn as string}>
                {r.msisdn}{r.employeeFullName ? ` — ${r.employeeFullName}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Карточка номера</label>
          <button className={styles.btnSecondary} disabled={!msisdn} onClick={() => setCardOpen(true)}>Открыть карточку</button>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Тип</label>
          <select className={styles.select} value={kind} onChange={e => setKind(e.target.value as 'service' | 'block')}>
            <option value="service">Услуга (PEXXXX)</option>
            <option value="block">Добровольная блокировка (BLXXXX)</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Код</label>
          <input className={styles.input} value={externalID} onChange={e => setExternalID(e.target.value)} placeholder="PE1234 / BL0005" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => onModify('add')} disabled={modifyService.isPending}>Добавить (2FA)</button>
        <button className={styles.btnSecondary} onClick={() => onModify('remove')} disabled={modifyService.isPending}>Удалить (2FA)</button>
      </div>

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 16 }}>Правила корпоративного бюджета выбранного номера</h3>
      {rules.isLoading && accountId && msisdn ? <p className={styles.hint}>Загрузка…</p> : null}
      {(rules.data ?? []).length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Правило</th><th>Лимит</th><th>Действует с</th><th></th></tr></thead>
            <tbody>
              {(rules.data ?? []).map((r, i) => (
                <tr key={`${r.productCode ?? 'rule'}-${i}`}>
                  <td>{r.title ?? r.productCode ?? '—'}</td>
                  <td>{r.limitValue ?? '—'}</td>
                  <td>{r.activeFrom ?? '—'}</td>
                  <td><button className={styles.btnSecondary} onClick={() => { void onRemoveRule(r); }} disabled={removeRule.isPending}>Удалить (2FA)</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.row} style={{ marginTop: 8 }}>
        <div className={styles.field}>
          <label className={styles.label}>Код правила</label>
          <input className={styles.input} value={ruleProductCode} onChange={e => setRuleProductCode(e.target.value)} placeholder="CB.RULE.XXXXX" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Версия правила</label>
          <input className={styles.input} value={ruleVersionId} onChange={e => setRuleVersionId(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лимит (необязательно)</label>
          <input className={styles.input} value={ruleLimit} onChange={e => setRuleLimit(e.target.value)} placeholder="1000" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => { void onAddRule(); }} disabled={addRule.isPending}>Добавить правило (2FA)</button>
      </div>

      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 16 }}>Заявки на управляющие действия</h3>
      {(actions.data ?? []).length === 0 ? (
        <p className={styles.hint}>Заявок нет.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Действие</th><th>Статус</th><th>Отправлено</th><th>Проверено</th></tr></thead>
            <tbody>
              {(actions.data ?? []).map(a => {
                const badge = STATUS_BADGE[a.status] ?? STATUS_BADGE.unknown;
                return (
                  <tr key={a.eventId}>
                    <td>{ACTION_TYPE_LABELS[a.actionType] ?? a.actionType}</td>
                    <td><span className={`${styles.badge} ${badge.cls}`}>{badge.label}</span></td>
                    <td>{fmtLast(a.requestedAt)}</td>
                    <td>{fmtLast(a.checkedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cardOpen && msisdn && <SubscriberCardModal msisdn={msisdn} onClose={() => setCardOpen(false)} />}
    </section>
  );
};

// ================= Страница с вкладками =================
export const MtsBusinessPage: FC = () => {
  const [tab, setTab] = useState<'main' | 'admin'>('main');
  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === 'main' ? styles.tabActive : ''}`} onClick={() => setTab('main')}>Основное</button>
        <button className={`${styles.tab} ${tab === 'admin' ? styles.tabActive : ''}`} onClick={() => setTab('admin')}>Администрирование</button>
      </div>

      {tab === 'main' && <OverviewSection />}
      {tab === 'admin' && (
        <>
          <AccountsSection />
          <SyncSection />
          <UploadSection />
          <NumberMapSection />
          <ActionsSection />
        </>
      )}
    </div>
  );
};
