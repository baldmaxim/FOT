import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessAccounts, useFetchSyncMtsBusinessDetalization } from '../../../hooks/useMtsBusinessData';
import { useRefreshMtsBusinessBilling } from '../../../hooks/useMtsBusinessBillingData';
import { useRefreshMtsBusinessCatalog } from '../../../hooks/useMtsBusinessCatalogData';
import {
  useMtsBusinessSchedulersStatus,
  useMtsBusinessRefreshAllSchedule,
  useSetMtsBusinessRefreshAllSchedule,
} from '../../../hooks/useMtsBusinessRefreshAll';
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

  const schedule = useMtsBusinessRefreshAllSchedule(true);
  const setSchedule = useSetMtsBusinessRefreshAllSchedule();
  // Локальные правки поверх сохранённого значения (null = не трогали);
  // после сохранения сбрасываются — источником снова становится запрос.
  const [schedEnabledDraft, setSchedEnabledDraft] = useState<boolean | null>(null);
  const [schedHourDraft, setSchedHourDraft] = useState<number | null>(null);
  const [schedMsg, setSchedMsg] = useState<Msg>(null);
  const schedEnabled = schedEnabledDraft ?? schedule.data?.enabled ?? false;
  const schedHour = schedHourDraft ?? schedule.data?.hourMsk ?? 23;

  const onSaveSchedule = async (): Promise<void> => {
    setSchedMsg(null);
    try {
      const next = await setSchedule.mutateAsync({ enabled: schedEnabled, hourMsk: schedHour });
      setSchedEnabledDraft(null);
      setSchedHourDraft(null);
      setSchedMsg({
        ok: true,
        text: next.enabled
          ? `Автообновление включено — ежедневно после ${String(next.hourMsk).padStart(2, '0')}:00 МСК`
          : 'Автообновление выключено',
      });
    } catch (e) {
      setSchedMsg({ ok: false, text: errText(e, 'Ошибка сохранения настройки (возможно нужен 2FA)') });
    }
  };

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

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 0 }}>Автообновление «Обновить всё»</h3>
      <p className={styles.hint}>
        Ежедневный полный прогон всех активных аккаунтов (номера, комментарии, балансы, детализация,
        профили абонентов). Если в этот час идёт ручной прогон — автозапуск отложится до его завершения.
      </p>
      <div className={styles.rowCompact}>
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={schedEnabled}
            onChange={e => setSchedEnabledDraft(e.target.checked)}
            disabled={schedule.isLoading}
          />
          Запускать ежедневно
        </label>
        <div className={styles.field}>
          <label className={styles.label}>Час запуска (МСК)</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            value={schedHour}
            onChange={e => setSchedHourDraft(Number(e.target.value))}
            disabled={schedule.isLoading}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
        <button className={styles.btnSecondary} onClick={() => { void onSaveSchedule(); }} disabled={setSchedule.isPending || schedule.isLoading}>
          {setSchedule.isPending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
      {schedMsg && <p className={schedMsg.ok ? styles.ok : styles.err}>{schedMsg.text}</p>}

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
      <div className={styles.rowCompact}>
        <div className={styles.field}>
          <label className={styles.label}>Аккаунт</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            style={{ minWidth: 200 }}
            value={accountId}
            onChange={e => { setAccountId(e.target.value); setSelected([]); }}
          >
            <option value="">{active.length ? '— выберите —' : 'нет аккаунтов'}</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Период с</label>
          <input className={`${styles.input} ${styles.inputSm}`} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>по</label>
          <input className={`${styles.input} ${styles.inputSm}`} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
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
