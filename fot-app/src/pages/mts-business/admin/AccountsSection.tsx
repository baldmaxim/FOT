import { type FC, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useMtsBusinessAccounts,
  useCreateMtsBusinessAccount,
  useUpdateMtsBusinessAccount,
  useDeleteMtsBusinessAccount,
} from '../../../hooks/useMtsBusinessData';
import { mtsBusinessService, type IMtsBusinessAccount } from '../../../services/mtsBusinessService';
import { errText } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

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
            {editing ? 'Сохранить' : 'Добавить'}
          </button>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>Отмена</button>
        </div>
      </div>
    </div>
  );
};

/** Аккаунты API / лицевые счета: список, проверка соединения, CRUD (2FA). */
export const AccountsSection: FC = () => {
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
    <>
      <div className={styles.actions} style={{ justifyContent: 'flex-end', marginTop: 0, marginBottom: 8 }}>
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
    </>
  );
};
