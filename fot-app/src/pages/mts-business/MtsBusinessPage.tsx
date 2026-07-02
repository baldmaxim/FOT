import { type FC, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useMtsBusinessAccounts,
  useMtsBusinessRequests,
  useMtsBusinessNumberMap,
  useMtsBusinessReport,
  useCreateMtsBusinessAccount,
  useUpdateMtsBusinessAccount,
  useDeleteMtsBusinessAccount,
  useOrderMtsBusinessDetalization,
  useRefreshMtsBusinessStatus,
  useUploadMtsBusinessDetalization,
  useSetMtsBusinessNumberMap,
} from '../../hooks/useMtsBusinessData';
import { mtsBusinessService, type IMtsBusinessAccount } from '../../services/mtsBusinessService';
import styles from './MtsBusinessPage.module.css';

const errText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

const pad = (n: number): string => String(n).padStart(2, '0');
const toISODate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatDuration = (sec: number): string => `${Math.floor(sec / 3600)}ч ${pad(Math.floor((sec % 3600) / 60))}м ${pad(sec % 60)}с`;

const statusBadge = (status: string): { cls: string; label: string } => {
  switch (status) {
    case 'completed': return { cls: styles.badgeOk, label: 'Готов' };
    case 'in_progress': return { cls: styles.badgeWait, label: 'В обработке' };
    case 'faulted': return { cls: styles.badgeErr, label: 'Ошибка' };
    default: return { cls: styles.badgeMuted, label: status || '—' };
  }
};

const AccountsSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const createM = useCreateMtsBusinessAccount();
  const updateM = useUpdateMtsBusinessAccount();
  const deleteM = useDeleteMtsBusinessAccount();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const rows = accounts.data ?? [];

  const resetForm = (): void => {
    setEditingId(null); setLabel(''); setAccountNumber(''); setLogin(''); setPassword(''); setBaseUrl('');
  };

  const startEdit = (a: IMtsBusinessAccount): void => {
    setEditingId(a.id); setLabel(a.label); setAccountNumber(a.accountNumber ?? '');
    setLogin(a.login); setPassword(''); setBaseUrl(a.baseUrl); setMsg(null);
  };

  const onSave = async (): Promise<void> => {
    setMsg(null);
    try {
      if (editingId) {
        await updateM.mutateAsync({
          id: editingId,
          data: {
            label: label.trim(), accountNumber: accountNumber.trim() || null, login: login.trim(),
            baseUrl: baseUrl.trim() || null,
            ...(password.trim() ? { password: password.trim() } : {}),
          },
        });
        setMsg({ ok: true, text: 'Аккаунт обновлён' });
      } else {
        await createM.mutateAsync({
          label: label.trim(), accountNumber: accountNumber.trim() || undefined,
          login: login.trim(), password: password.trim(), baseUrl: baseUrl.trim() || undefined,
        });
        setMsg({ ok: true, text: 'Аккаунт добавлен' });
      }
      resetForm();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка сохранения аккаунта (возможно нужен 2FA)') });
    }
  };

  const onTest = async (id: string): Promise<void> => {
    setTestResults(prev => ({ ...prev, [id]: { ok: false, text: 'Проверка…' } }));
    try {
      const r = await mtsBusinessService.testAccount(id);
      setTestResults(prev => ({ ...prev, [id]: r.ok ? { ok: true, text: 'OK' } : { ok: false, text: r.error || 'Ошибка' } }));
    } catch (e) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, text: errText(e, 'Ошибка') } }));
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('Удалить аккаунт?')) return;
    setMsg(null);
    try {
      await deleteM.mutateAsync(id);
      if (editingId === id) resetForm();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка удаления (возможно нужен 2FA)') });
    }
  };

  const busy = createM.isPending || updateM.isPending;

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Аккаунты МТС Бизнес (несколько API/счетов)</h2>
      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Название</th><th>ЛС</th><th>Логин</th><th>Base URL</th><th>Статус</th><th></th></tr></thead>
            <tbody>
              {rows.map(a => {
                const t = testResults[a.id];
                return (
                  <tr key={a.id}>
                    <td>{a.label}</td>
                    <td>{a.accountNumber ?? '—'}</td>
                    <td>{a.login}</td>
                    <td><code>{a.baseUrl}</code></td>
                    <td>
                      {a.isActive
                        ? <span className={`${styles.badge} ${styles.badgeOk}`}>активен</span>
                        : <span className={`${styles.badge} ${styles.badgeMuted}`}>выкл</span>}
                      {t && <span className={t.ok ? styles.ok : styles.err} style={{ marginLeft: 6 }}>{t.text}</span>}
                    </td>
                    <td>
                      <button className={styles.btnSecondary} onClick={() => onTest(a.id)}>Проверить</button>{' '}
                      <button className={styles.btnSecondary} onClick={() => startEdit(a)}>Изменить</button>{' '}
                      <button className={styles.btnSecondary} onClick={() => onDelete(a.id)} disabled={deleteM.isPending}>Удалить</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className={styles.cardTitle} style={{ marginTop: 14 }}>{editingId ? 'Изменить аккаунт' : 'Добавить аккаунт'}</h3>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Название</label>
          <input className={styles.input} type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="СУ-10 основной" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт (ЛС)</label>
          <input className={styles.input} type="text" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="277308204324" />
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Логин</label>
          <input className={styles.input} type="text" autoComplete="off" value={login} onChange={e => setLogin(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Пароль {editingId && '(пусто — не менять)'}</label>
          <input className={styles.input} type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Base URL (необязательно)</label>
        <input className={styles.input} type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.mts.ru/b2b/v1" />
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onSave} disabled={busy || !label.trim() || !login.trim() || (!editingId && !password.trim())}>
          {editingId ? 'Сохранить' : 'Добавить'} (нужен 2FA)
        </button>
        {editingId && <button className={styles.btnSecondary} onClick={resetForm} disabled={busy}>Отмена</button>}
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const onOrder = async (): Promise<void> => {
    setMsg(null);
    const acc = accountId || active[0]?.id;
    if (!acc) { setMsg({ ok: false, text: 'Сначала добавьте и выберите аккаунт' }); return; }
    const list = targets.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) { setMsg({ ok: false, text: 'Укажите хотя бы один номер/лицевой счёт' }); return; }
    try {
      const r = await order.mutateAsync({ accountId: acc, scope, targets: list, dateFrom, dateTo, deliveryAddress: email.trim() });
      setMsg({ ok: true, text: `Заявка создана. messageId: ${r.messageId}. Документ придёт на email.` });
      setTargets('');
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка заказа детализации') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Заказать детализацию</h2>
      <p className={styles.hint}>Документ формируется как файл и уходит на email. Затем загрузите его ниже — система посчитает время разговоров.</p>
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
      </div>
      <div className={styles.row}>
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
        <label className={styles.label}>{scope === 'account' ? 'Лицевые счета (через запятую/пробел)' : 'Номера 7XXXXXXXXXX (через запятую/пробел)'}</label>
        <textarea className={styles.textarea} value={targets} onChange={e => setTargets(e.target.value)} placeholder="79001234567, 79007654321" />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Email для документа</label>
        <input className={styles.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="mailbox@example.com" />
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onOrder} disabled={order.isPending || active.length === 0}>Заказать (нужен 2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

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
          <thead><tr><th>messageId</th><th>Тип</th><th>Кол-во</th><th>Период</th><th>Статус</th><th>Проверено</th><th></th></tr></thead>
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
                  <td>{r.checkedAt ? new Date(r.checkedAt).toLocaleString('ru-RU') : '—'}</td>
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

const UploadSection: FC = () => {
  const upload = useUploadMtsBusinessDetalization();
  const [file, setFile] = useState<File | null>(null);
  const [msisdn, setMsisdn] = useState('');
  const [sourceMessageId, setSourceMessageId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const onUpload = async (): Promise<void> => {
    setMsg(null);
    if (!file) { setMsg({ ok: false, text: 'Выберите файл детализации (XLS/XML)' }); return; }
    try {
      const r = await upload.mutateAsync({ file, msisdn: msisdn.trim() || undefined, sourceMessageId: sourceMessageId.trim() || undefined });
      setMsg({ ok: true, text: `Разобрано: ${r.parsed}, добавлено: ${r.inserted}, пропущено (дубли): ${r.skipped}` });
      setFile(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка обработки файла') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Загрузка детализации (XLS/XML)</h2>
      <p className={styles.hint}>Загрузите файл-отчёт (Excel .xls/.xlsx или XML). Свой номер берётся из имени листа; если файл по одному номеру без него — впишите номер ниже.</p>
      <div className={styles.field}>
        <label className={styles.label}>Файл</label>
        <input className={styles.input} type="file" accept=".xls,.xlsx,.xml,application/vnd.ms-excel,text/xml,application/xml"
          onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Номер (если не указан в файле)</label>
          <input className={styles.input} type="text" value={msisdn} onChange={e => setMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>messageId заявки (необязательно)</label>
          <input className={styles.input} type="text" value={sourceMessageId} onChange={e => setSourceMessageId(e.target.value)} />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onUpload} disabled={upload.isPending || !file}>Загрузить (нужен 2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </section>
  );
};

const NumberMapSection: FC = () => {
  const map = useMtsBusinessNumberMap(true);
  const setMap = useSetMtsBusinessNumberMap();
  const [msisdn, setMsisdn] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = map.data ?? [];

  const onAdd = async (): Promise<void> => {
    setMsg(null);
    if (!msisdn.trim()) { setMsg({ ok: false, text: 'Укажите номер' }); return; }
    const empId = employeeId.trim() ? Number(employeeId.trim()) : null;
    if (employeeId.trim() && !Number.isFinite(empId)) { setMsg({ ok: false, text: 'ID сотрудника — число' }); return; }
    try {
      await setMap.mutateAsync({ msisdn: msisdn.trim(), employeeId: empId });
      setMsisdn(''); setEmployeeId('');
      setMsg({ ok: true, text: 'Привязка сохранена' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка сохранения привязки') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Привязка номеров к сотрудникам</h2>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Номер</label>
          <input className={styles.input} type="text" value={msisdn} onChange={e => setMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>ID сотрудника (пусто — снять)</label>
          <input className={styles.input} type="text" value={employeeId} onChange={e => setEmployeeId(e.target.value)} placeholder="123" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onAdd} disabled={setMap.isPending}>Сохранить привязку (нужен 2FA)</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
      {rows.length > 0 && (
        <div className={styles.tableWrap} style={{ marginTop: 12 }}>
          <table className={styles.table}>
            <thead><tr><th>Номер</th><th>Сотрудник</th><th>Таб. №</th><th>Привязан</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.msisdn ?? `row-${i}`}>
                  <td>{r.msisdn ?? '—'}</td>
                  <td>{r.employeeFullName ?? <span className={`${styles.badge} ${styles.badgeMuted}`}>не привязан</span>}</td>
                  <td>{r.employeeTabNumber ?? '—'}</td>
                  <td>{r.linkedAt ? new Date(r.linkedAt).toLocaleDateString('ru-RU') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

const ReportSection: FC = () => {
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(toISODate(now));
  const report = useMtsBusinessReport(from, to, true);
  const rows = report.data ?? [];
  const totalSec = rows.reduce((acc, r) => acc + r.totalSeconds, 0);

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Время разговоров по сотрудникам</h2>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>С</label>
          <input className={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>По</label>
          <input className={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </div>
      {report.isLoading ? (
        <p className={styles.hint}>Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className={styles.hint}>Нет данных за период. Загрузите детализацию и привяжите номера.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Сотрудник</th><th>Таб. №</th><th>Звонков</th><th>Время разговоров</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.employeeId ?? `unmapped-${i}`}>
                  <td>{r.employeeFullName ?? <span className={`${styles.badge} ${styles.badgeMuted}`}>не привязанные номера</span>}</td>
                  <td>{r.employeeTabNumber ?? '—'}</td>
                  <td>{r.calls}</td>
                  <td>{formatDuration(r.totalSeconds)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>Итого</th><th></th><th>{rows.reduce((a, r) => a + r.calls, 0)}</th><th>{formatDuration(totalSec)}</th></tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
};

export const MtsBusinessPage: FC = () => (
  <div className={styles.page}>
    <AccountsSection />
    <OrderSection />
    <RequestsSection />
    <UploadSection />
    <NumberMapSection />
    <ReportSection />
  </div>
);
