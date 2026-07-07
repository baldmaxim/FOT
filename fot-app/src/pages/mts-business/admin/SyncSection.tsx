import { type FC, useState } from 'react';
import { useRefreshMtsBusinessBilling } from '../../../hooks/useMtsBusinessBillingData';
import { useRefreshMtsBusinessCatalog } from '../../../hooks/useMtsBusinessCatalogData';
import {
  useMtsBusinessSchedulersStatus,
  useMtsBusinessRefreshAllSchedule,
  useSetMtsBusinessRefreshAllSchedule,
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
