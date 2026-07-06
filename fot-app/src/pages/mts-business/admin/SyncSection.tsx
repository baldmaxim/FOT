import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessAccounts, useFetchSyncMtsBusinessDetalization } from '../../../hooks/useMtsBusinessData';
import { useRefreshMtsBusinessBilling } from '../../../hooks/useMtsBusinessBillingData';
import { useRefreshMtsBusinessCatalog } from '../../../hooks/useMtsBusinessCatalogData';
import { useMtsBusinessSchedulersStatus } from '../../../hooks/useMtsBusinessRefreshAll';
import { NumberFioPicker } from '../NumberFioPicker';
import { errText, toISODate, fmtLast } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

/**
 * Синхронизация: статусы фоновых планировщиков, точечные обновления (финансы/
 * каталог) и ручной бэкафилл детализации за произвольный период.
 */
export const SyncSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const fetchSync = useFetchSyncMtsBusinessDetalization();
  const refreshBilling = useRefreshMtsBusinessBilling();
  const refreshCatalog = useRefreshMtsBusinessCatalog();
  const schedulers = useMtsBusinessSchedulersStatus(true);
  const now = useMemo(() => new Date(), []);
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const [accountId, setAccountId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [dateTo, setDateTo] = useState(toISODate(now));
  const [msg, setMsg] = useState<Msg>(null);
  const [refreshMsg, setRefreshMsg] = useState<Msg>(null);

  const effAccountId = accountId || active[0]?.id || '';

  const onFetch = async (): Promise<void> => {
    setMsg(null);
    const acc = effAccountId;
    if (!acc) { setMsg({ ok: false, text: 'Сначала добавьте аккаунт' }); return; }
    if (selected.length === 0) { setMsg({ ok: false, text: 'Выберите хотя бы одного сотрудника' }); return; }
    try {
      const r = await fetchSync.mutateAsync({ accountId: acc, msisdns: selected, dateFrom, dateTo });
      const notConnected = (r.failed ?? []).filter(f => f.reason === 'MTS_FEATURE_NOT_CONNECTED').length;
      const failedText = r.failedNumbers.length
        ? notConnected === r.failedNumbers.length
          ? `; детализация не подключена в тарифе МТС (${notConnected} номеров) — обратитесь к менеджеру МТС`
          : `; ошибки по номерам: ${r.failedNumbers.join(', ')}`
        : '';
      setMsg({ ok: r.failedNumbers.length === 0, text: `Разобрано звонков: ${r.parsed}, добавлено: ${r.inserted}, пропущено (дубли): ${r.skipped}${failedText}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка загрузки детализации') });
    }
  };

  const onRefreshBilling = async (): Promise<void> => {
    setRefreshMsg(null);
    try {
      const r = await refreshBilling.mutateAsync(accountId || undefined);
      setRefreshMsg({ ok: true, text: `Обновление финансов запущено (ЛС: ${r.accounts}) — данные появятся через несколько минут` });
    } catch (e) {
      setRefreshMsg({ ok: false, text: errText(e, 'Ошибка запуска обновления (возможно нужен 2FA)') });
    }
  };
  const onRefreshCatalog = async (): Promise<void> => {
    setRefreshMsg(null);
    try {
      const r = await refreshCatalog.mutateAsync(accountId || undefined);
      setRefreshMsg({ ok: true, text: `Обновление каталога запущено (ЛС: ${r.accounts}) — данные появятся через несколько минут` });
    } catch (e) {
      setRefreshMsg({ ok: false, text: errText(e, 'Ошибка запуска обновления каталога (возможно нужен 2FA)') });
    }
  };

  return (
    <>
      {(schedulers.data ?? []).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {(schedulers.data ?? []).map(row => (
            <div key={row.id} className={styles.schedRow}>
              <span>
                {row.label}
                {row.lastStatus === 'error' && row.lastMessage && (
                  <span className={styles.err} style={{ marginLeft: 6 }}>{row.lastMessage}</span>
                )}
              </span>
              <span className={styles.schedMeta}>
                {row.lastStatus == null
                  ? 'ещё не выполнялся'
                  : <>
                      {fmtLast(row.lastRunAt)}{' '}
                      <span className={`${styles.badge} ${row.lastStatus === 'ok' ? styles.badgeOk : styles.badgeErr}`}>
                        {row.lastStatus === 'ok' ? 'ок' : 'ошибка'}
                      </span>
                    </>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.actions} style={{ marginTop: 0, marginBottom: 12 }}>
        <button className={styles.btnSecondary} onClick={() => { void onRefreshBilling(); }} disabled={refreshBilling.isPending}>
          Обновить финансы
        </button>
        <button className={styles.btnSecondary} onClick={() => { void onRefreshCatalog(); }} disabled={refreshCatalog.isPending}>
          Обновить каталог
        </button>
      </div>
      {refreshMsg && <p className={refreshMsg.ok ? styles.ok : styles.err}>{refreshMsg.text}</p>}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 12 }}>Детализация за период (вручную)</h3>
      <p className={styles.hint}>
        Автообновление — раз в сутки без участия. Здесь — разовая загрузка за произвольный период
        (например, для нового номера или досрочной проверки).
      </p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Аккаунт</label>
          <select className={styles.select} value={accountId} onChange={e => { setAccountId(e.target.value); setSelected([]); }}>
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
        <label className={styles.label}>Сотрудники / номера (по ФИО)</label>
        <NumberFioPicker accountId={effAccountId} value={selected} onChange={setSelected} />
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onFetch} disabled={fetchSync.isPending || active.length === 0}>
          {fetchSync.isPending ? 'Загрузка…' : 'Загрузить за период'}
        </button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </>
  );
};
