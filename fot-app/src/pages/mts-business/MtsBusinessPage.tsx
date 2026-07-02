import { type FC, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  useMtsBusinessAccounts,
  useMtsBusinessRequests,
  useMtsBusinessImportedNumbers,
  useMtsBusinessReport,
  useMtsBusinessAccountsSummary,
  useCreateMtsBusinessAccount,
  useUpdateMtsBusinessAccount,
  useDeleteMtsBusinessAccount,
  useOrderMtsBusinessDetalization,
  useRefreshMtsBusinessStatus,
  useUploadMtsBusinessDetalization,
  useSetMtsBusinessNumberMap,
} from '../../hooks/useMtsBusinessData';
import { mtsBusinessService, type IMtsBusinessAccount } from '../../services/mtsBusinessService';
import { EmployeeFioPicker } from '../mts/EmployeeFioPicker';
import styles from './MtsBusinessPage.module.css';

const errText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

const pad = (n: number): string => String(n).padStart(2, '0');
const toISODate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDur = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${pad(m)} м` : `${m} м ${pad(sec % 60)} с`;
};

const statusBadge = (status: string): { cls: string; label: string } => {
  switch (status) {
    case 'completed': return { cls: styles.badgeOk, label: 'Готов' };
    case 'in_progress': return { cls: styles.badgeWait, label: 'В обработке' };
    case 'faulted': return { cls: styles.badgeErr, label: 'Ошибка' };
    default: return { cls: styles.badgeMuted, label: status || '—' };
  }
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
  const [msg, setMsg] = useState<Msg>(null);
  const overlay = useOverlayDismiss(onClose);

  const busy = createM.isPending || updateM.isPending;
  const onSave = async (): Promise<void> => {
    setMsg(null);
    try {
      if (account) {
        await updateM.mutateAsync({
          id: account.id,
          data: {
            label: label.trim(), accountNumber: accountNumber.trim() || null, login: login.trim(),
            baseUrl: baseUrl.trim() || null, ...(password.trim() ? { password: password.trim() } : {}),
          },
        });
      } else {
        await createM.mutateAsync({
          label: label.trim(), accountNumber: accountNumber.trim() || undefined,
          login: login.trim(), password: password.trim(), baseUrl: baseUrl.trim() || undefined,
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

// ================= Заказ детализации =================
const OrderSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const order = useOrderMtsBusinessDetalization();
  const now = useMemo(() => new Date(), []);
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const [accountId, setAccountId] = useState('');
  const [scope, setScope] = useState<'msisdn' | 'account'>('msisdn');
  const [targets, setTargets] = useState('');
  const [dateFrom, setDateFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [dateTo, setDateTo] = useState(toISODate(now));
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const onOrder = async (): Promise<void> => {
    setMsg(null);
    const acc = accountId || active[0]?.id;
    if (!acc) { setMsg({ ok: false, text: 'Сначала добавьте аккаунт' }); return; }
    let list = targets.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    // «По лицевым счетам» с пустым полем = все номера ЛС выбранного аккаунта.
    if (list.length === 0 && scope === 'account') {
      const accNumber = active.find(a => a.id === acc)?.accountNumber;
      if (accNumber) list = [accNumber];
    }
    if (list.length === 0) {
      setMsg({
        ok: false,
        text: scope === 'account'
          ? 'Укажите лицевой счёт (или заполните ЛС в аккаунте)'
          : 'Укажите номера — либо выберите тип «По лицевым счетам», чтобы заказать по всем номерам ЛС разом',
      });
      return;
    }
    try {
      const r = await order.mutateAsync({ accountId: acc, scope, targets: list, dateFrom, dateTo, deliveryAddress: email.trim() });
      setMsg({ ok: true, text: `Заявка создана (messageId: ${r.messageId}). Документ придёт на email.` });
      setTargets('');
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка заказа детализации') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Заказать детализацию</h2>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Аккаунт</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">{active.length ? '— выберите —' : 'нет аккаунтов'}</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Тип</label>
          <select className={styles.select} value={scope} onChange={e => setScope(e.target.value as 'msisdn' | 'account')}>
            <option value="msisdn">По номерам</option>
            <option value="account">По лицевым счетам</option>
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
        <label className={styles.label}>{scope === 'account' ? 'Лицевые счета (через запятую; пусто — ЛС выбранного аккаунта, все его номера)' : 'Номера 7XXXXXXXXXX (через запятую)'}</label>
        <textarea
          className={styles.textarea}
          value={targets}
          onChange={e => setTargets(e.target.value)}
          placeholder={scope === 'account' ? 'пусто — все номера лицевого счёта' : '79001234567, 79007654321'}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Email для документа</label>
        <input className={styles.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="пусто — служебный ящик автозабора" />
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onOrder} disabled={order.isPending || active.length === 0}>Заказать (2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

// ================= Заявки =================
const RequestsSection: FC = () => {
  const requests = useMtsBusinessRequests(true);
  const refresh = useRefreshMtsBusinessStatus();
  const rows = requests.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Заявки на детализацию</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>messageId</th><th>Тип</th><th>Кол-во</th><th>Период</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => {
              const b = statusBadge(r.status);
              return (
                <tr key={r.messageId}>
                  <td><code>{r.messageId}</code></td>
                  <td>{r.scope === 'account' ? 'счета' : 'номера'}</td>
                  <td>{r.targetCount}</td>
                  <td>{r.dateFrom} — {r.dateTo}</td>
                  <td><span className={`${styles.badge} ${b.cls}`}>{b.label}</span></td>
                  <td><button className={styles.btnSecondary} onClick={() => refresh.mutate(r.messageId)} disabled={refresh.isPending}>Обновить</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  const [manualMsisdn, setManualMsisdn] = useState('');
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

  const fmtLast = (iso: string | null): string => iso
    ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Импортированные номера — привязка к сотрудникам</h2>
      <p className={styles.hint}>Все свои номера из загруженных детализаций. Найдите сотрудника по ФИО в строке номера — его время разговоров появится в отчёте «По сотрудникам». Сохранение требует 2FA.</p>
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
                  <td>{r.msisdn ?? '—'}</td>
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
    </section>
  );
};

// ================= Дашборд «Основное» =================
const Bars: FC<{ items: { key: string; label: string; sub?: string; value: number; active?: boolean; onClick?: () => void }[] }> = ({ items }) => {
  const max = Math.max(1, ...items.map(i => i.value));
  return (
    <div>
      {items.map(it => (
        <div
          key={it.key}
          className={`${styles.barRow} ${it.onClick ? styles.barRowClickable : ''} ${it.active ? styles.barRowActive : ''}`}
          onClick={it.onClick}
        >
          <div style={{ minWidth: 0 }}>
            <div className={styles.barLabel}>{it.label}{it.sub && <span className={styles.barSub}> · {it.sub}</span>}</div>
            <div className={styles.barTrack}><div className={styles.barFill} style={{ width: `${Math.round((it.value / max) * 100)}%` }} /></div>
          </div>
          <div className={styles.barValue}>{fmtDur(it.value)}</div>
        </div>
      ))}
    </div>
  );
};

const DashboardSection: FC = () => {
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(toISODate(now));
  const [view, setView] = useState<'accounts' | 'employees'>('accounts');
  const [accountId, setAccountId] = useState<string>(''); // фильтр по ЛС в режиме сотрудников

  const summary = useMtsBusinessAccountsSummary(from, to, true);
  const report = useMtsBusinessReport(from, to, view === 'employees', accountId || undefined);
  const accountsMeta = useMtsBusinessAccounts();

  const accRows = summary.data ?? [];
  const totalCalls = accRows.reduce((a, r) => a + r.calls, 0);
  const totalSec = accRows.reduce((a, r) => a + r.totalSeconds, 0);
  const accountsWithData = accRows.filter(r => r.accountId).length;
  const empRows = (report.data ?? []).filter(r => r.employeeId != null);
  const mappedEmployees = empRows.length;

  const accBars = accRows.map(r => ({
    key: r.accountId ?? 'none',
    label: r.label ?? (r.accountId ? 'Без названия' : 'Без привязки к ЛС'),
    sub: [r.accountNumber, `${r.calls} зв.`, `${r.numbers} ном.`].filter(Boolean).join(' · '),
    value: r.totalSeconds,
    active: false,
    onClick: r.accountId ? () => { setAccountId(r.accountId as string); setView('employees'); } : undefined,
  }));

  const empBars = (report.data ?? []).map((r, i) => ({
    key: r.employeeId != null ? String(r.employeeId) : `unmapped-${i}`,
    label: r.employeeFullName ?? 'Не привязанные номера',
    sub: [r.employeeTabNumber, `${r.calls} зв.`, `вх ${fmtDur(r.inSeconds)}`, `исх ${fmtDur(r.outSeconds)}`].filter(Boolean).join(' · '),
    value: r.totalSeconds,
  }));

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label}>Период с</label>
            <input className={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>по</label>
            <input className={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>
        <div className={styles.kpiGrid}>
          <div className={styles.kpi}><div className={styles.kpiValue}>{fmtDur(totalSec)}</div><div className={styles.kpiLabel}>Время разговоров</div></div>
          <div className={styles.kpi}><div className={styles.kpiValue}>{totalCalls.toLocaleString('ru-RU')}</div><div className={styles.kpiLabel}>Звонков</div></div>
          <div className={styles.kpi}><div className={styles.kpiValue}>{accountsWithData}</div><div className={styles.kpiLabel}>Лицевых счетов</div></div>
          <div className={styles.kpi}><div className={styles.kpiValue}>{totalCalls ? fmtDur(Math.round(totalSec / totalCalls)) : '—'}</div><div className={styles.kpiLabel}>Средний звонок</div></div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.actions} style={{ justifyContent: 'space-between', marginTop: 0 }}>
          <div className={styles.segment}>
            <button className={`${styles.segBtn} ${view === 'accounts' ? styles.segBtnActive : ''}`} onClick={() => setView('accounts')}>По лицевым счетам</button>
            <button className={`${styles.segBtn} ${view === 'employees' ? styles.segBtnActive : ''}`} onClick={() => setView('employees')}>По сотрудникам</button>
          </div>
          {view === 'employees' && (
            <select className={styles.select} style={{ maxWidth: 260 }} value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">Все лицевые счета</option>
              {(accountsMeta.data ?? []).map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
            </select>
          )}
        </div>

        {view === 'accounts' ? (
          summary.isLoading ? <p className={styles.hint}>Загрузка…</p>
            : accBars.length === 0 ? <p className={styles.hint}>Нет данных за период. Загрузите детализацию (вкладка «Администрирование»).</p>
              : <Bars items={accBars} />
        ) : (
          report.isLoading ? <p className={styles.hint}>Загрузка…</p>
            : empBars.length === 0 ? <p className={styles.hint}>Нет данных. Загрузите детализацию и привяжите номера к сотрудникам.</p>
              : <>
                  <p className={styles.hint}>Сотрудников с данными: {mappedEmployees}. Клик по ЛС на вкладке слева фильтрует список.</p>
                  <Bars items={empBars} />
                </>
        )}
      </section>
    </div>
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

      {tab === 'main' ? (
        <DashboardSection />
      ) : (
        <>
          <AccountsSection />
          <OrderSection />
          <RequestsSection />
          <UploadSection />
          <NumberMapSection />
        </>
      )}
    </div>
  );
};
