import { type FC, useState } from 'react';
import { useRefreshMtsBusinessBilling } from '../../../hooks/useMtsBusinessBillingData';
import { useRefreshMtsBusinessCatalog } from '../../../hooks/useMtsBusinessCatalogData';
import {
  useMtsBusinessSchedulersStatus,
  useMtsBusinessRefreshAllSchedule,
  useSetMtsBusinessRefreshAllSchedule,
  useMtsBusinessRolling,
  useSetMtsBusinessRolling,
} from '../../../hooks/useMtsBusinessRefreshAll';
import { errText, fmtLast } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

/**
 * Синхронизация: статусы фоновых планировщиков, настройка автообновления и
 * точечные обновления (финансы/каталог). Разовая детализация по номеру — во
 * вкладке «Использование» карточки абонента; загрузка XML — в соседней карточке.
 */
export const SyncSection: FC = () => {
  const refreshBilling = useRefreshMtsBusinessBilling();
  const refreshCatalog = useRefreshMtsBusinessCatalog();
  const schedulers = useMtsBusinessSchedulersStatus(true);
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

  // Непрерывный конвейер свежести: те же «черновики поверх сохранённого», что и
  // у расписания — после сохранения источником снова становится запрос.
  const rolling = useMtsBusinessRolling(true);
  const setRolling = useSetMtsBusinessRolling();
  const [rollingEnabledDraft, setRollingEnabledDraft] = useState<boolean | null>(null);
  const [hotDraft, setHotDraft] = useState<number | null>(null);
  const [coldDraft, setColdDraft] = useState<number | null>(null);
  const [shareDraft, setShareDraft] = useState<number | null>(null);
  const [rollingMsg, setRollingMsg] = useState<Msg>(null);
  const rollingEnabled = rollingEnabledDraft ?? rolling.data?.enabled ?? false;
  const hotMinutes = hotDraft ?? rolling.data?.settings?.hotMinutes ?? 15;
  const coldHours = coldDraft ?? rolling.data?.settings?.coldHours ?? 6;
  const budgetShare = shareDraft ?? rolling.data?.settings?.budgetSharePercent ?? 70;

  const onSaveRolling = async (): Promise<void> => {
    setRollingMsg(null);
    try {
      const next = await setRolling.mutateAsync({
        enabled: rollingEnabled,
        hotMinutes,
        coldHours,
        budgetSharePercent: budgetShare,
      });
      setRollingEnabledDraft(null);
      setHotDraft(null);
      setColdDraft(null);
      setShareDraft(null);
      setRollingMsg({
        ok: true,
        text: next.enabled
          ? `Непрерывное обновление включено: активные номера — раз в ${next.hotMinutes} мин, остальные — раз в ${next.coldHours} ч`
          : 'Непрерывное обновление выключено',
      });
    } catch (e) {
      setRollingMsg({ ok: false, text: errText(e, 'Ошибка сохранения настройки (возможно нужен 2FA)') });
    }
  };

  const onRefreshBilling = async (): Promise<void> => {
    setRefreshMsg(null);
    try {
      const r = await refreshBilling.mutateAsync(undefined);
      setRefreshMsg({ ok: true, text: `Обновление финансов запущено (ЛС: ${r.accounts}) — данные появятся через несколько минут` });
    } catch (e) {
      setRefreshMsg({ ok: false, text: errText(e, 'Ошибка запуска обновления (возможно нужен 2FA)') });
    }
  };
  const onRefreshCatalog = async (): Promise<void> => {
    setRefreshMsg(null);
    try {
      const r = await refreshCatalog.mutateAsync(undefined);
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
                {row.lastStatus === 'partial' && row.lastMessage && (
                  <span className={styles.warn} style={{ marginLeft: 6 }}>{row.lastMessage}</span>
                )}
              </span>
              <span className={styles.schedMeta}>
                {row.lastStatus == null
                  ? 'ещё не выполнялся'
                  : <>
                      {fmtLast(row.lastRunAt)}{' '}
                      <span className={`${styles.badge} ${
                        row.lastStatus === 'ok' ? styles.badgeOk : row.lastStatus === 'partial' ? styles.badgeWait : styles.badgeErr
                      }`}>
                        {row.lastStatus === 'ok' ? 'ок' : row.lastStatus === 'partial' ? 'частично' : 'ошибка'}
                      </span>
                    </>}
              </span>
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 0 }}>Непрерывное обновление (звонки и начисления)</h3>
      <p className={styles.hint}>
        Фоновый конвейер постоянно догружает свежую выписку по всем лицевым счетам: номера
        обновляются по очереди «кого дольше всех не обновляли». МТС отдаёт звонок в выписке через
        6–12 минут после разговора, поэтому данные почти живые. Тратится только указанная доля
        лимита запросов — остаток остаётся карточкам абонентов и личным кабинетам.
        Профили (тариф, услуги, персданные) сюда не входят — они обновляются ночным «Обновить».
      </p>
      <div className={styles.rowCompact}>
        <div className={styles.field}>
          <label className={styles.label}>Активные номера, раз в</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            value={hotMinutes}
            onChange={e => setHotDraft(Number(e.target.value))}
            disabled={rolling.isLoading}
          >
            {[10, 15, 20, 30, 60].map(m => <option key={m} value={m}>{m} мин</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Остальные, раз в</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            value={coldHours}
            onChange={e => setColdDraft(Number(e.target.value))}
            disabled={rolling.isLoading}
          >
            {[3, 6, 12, 24].map(h => <option key={h} value={h}>{h} ч</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Доля лимита МТС</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            value={budgetShare}
            onChange={e => setShareDraft(Number(e.target.value))}
            disabled={rolling.isLoading}
          >
            {[30, 50, 70, 90].map(p => <option key={p} value={p}>{p}%</option>)}
          </select>
        </div>
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={rollingEnabled}
            onChange={e => setRollingEnabledDraft(e.target.checked)}
            disabled={rolling.isLoading}
          />
          Включить
        </label>
        <button className={styles.btn} onClick={() => { void onSaveRolling(); }} disabled={setRolling.isPending || rolling.isLoading}>
          {setRolling.isPending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
      {rollingMsg && <p className={rollingMsg.ok ? styles.ok : styles.err}>{rollingMsg.text}</p>}
      {rolling.data?.dryRun && (
        <p className={styles.warn}>Режим DRY-RUN (MTS_ROLLING_DRY_RUN=1): очередь строится, но запросы в МТС не уходят.</p>
      )}
      {rolling.data?.enabled && (
        <div style={{ marginTop: 8 }}>
          <p className={styles.hint}>
            Последний тик: {fmtLast(rolling.data.lastTickAt)} · обновлено за час: {rolling.data.syncedLastHour}
          </p>
          {rolling.data.accounts.map(a => (
            <div key={a.accountId} className={styles.schedRow}>
              <span>{a.accountLabel}</span>
              <span className={styles.schedMeta}>
                в очереди: {a.pending} · обновлено: {a.synced}
                {a.noAccess > 0 && ` · нет доступа: ${a.noAccess}`}
                {a.failed > 0 && <span className={styles.err}> · ошибок: {a.failed}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 20 }}>Автообновление «Обновить» (полный прогон)</h3>
      <p className={styles.hint}>
        Ежедневный полный прогон всех активных аккаунтов (номера, комментарии, балансы, детализация,
        профили абонентов). Если в этот час идёт ручной прогон — автозапуск отложится до его завершения.
      </p>
      <div className={styles.rowCompact}>
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
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={schedEnabled}
            onChange={e => setSchedEnabledDraft(e.target.checked)}
            disabled={schedule.isLoading}
          />
          Запускать ежедневно
        </label>
        <button className={styles.btn} onClick={() => { void onSaveSchedule(); }} disabled={setSchedule.isPending || schedule.isLoading}>
          {setSchedule.isPending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
      {schedMsg && <p className={schedMsg.ok ? styles.ok : styles.err}>{schedMsg.text}</p>}

      <div className={styles.actions} style={{ marginTop: 16 }}>
        <button className={styles.btnTinted} onClick={() => { void onRefreshBilling(); }} disabled={refreshBilling.isPending}>
          Обновить финансы
        </button>
        <button className={styles.btnTinted} onClick={() => { void onRefreshCatalog(); }} disabled={refreshCatalog.isPending}>
          Обновить каталог
        </button>
      </div>
      {refreshMsg && <p className={refreshMsg.ok ? styles.ok : styles.err}>{refreshMsg.text}</p>}
    </>
  );
};
