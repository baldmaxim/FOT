import { type FC, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMtsConnectionSettings,
  useMtsRawSubscriberDebug,
  getMtsConnectionQueryKey,
  getMtsSubscribersQueryKey,
  getMtsLocationsQueryKey,
  getMtsMappingsQueryKey,
} from '../../hooks/useMtsData';
import { mtsService, type IMtsTestResult, type IMtsRawSubscriberDebug } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import styles from './MtsPage.module.css';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

export const ConnectionTab: FC = () => {
  const queryClient = useQueryClient();
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [diag, setDiag] = useState<IMtsTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [debugData, setDebugData] = useState<IMtsRawSubscriberDebug | null>(null);
  const debugMutation = useMtsRawSubscriberDebug();

  const saveConnection = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await mtsService.saveConnectionSettings({
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setToken('');
      setBaseUrl('');
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getMtsConnectionQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getMtsMappingsQueryKey() }),
      ]);
      setStatus({ ok: true, msg: 'Настройки сохранены' });
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка сохранения (возможно нужен код 2FA)') });
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setStatus(null);
    setDiag(null);
    try {
      const r = await mtsService.testConnection();
      setDiag(r);
      setStatus(
        r.ok
          ? { ok: true, msg: `Подключение успешно. Абонентов: ${r.count}` }
          : { ok: false, msg: r.error || 'Подключение не удалось' },
      );
      if (r.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() }),
        ]);
      }
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка проверки подключения') });
    } finally {
      setBusy(false);
    }
  };

  const runDebug = async () => {
    setStatus(null);
    try {
      const r = await debugMutation.mutateAsync();
      setDebugData(r);
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка диагностики (нужен админ)') });
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Подключение МТС «Мобильные сотрудники»</h2>

      {configured && !editing ? (
        <>
          <p className={styles.ok}>
            ✓ Подключение настроено. Источник: <b>{connQuery.data?.source ?? '—'}</b>. Base URL:{' '}
            <code>{connQuery.data?.baseUrl}</code>
          </p>
          <p className={styles.hint}>
            Токен хранится в БД зашифрованным (AES-256-GCM). Для замены нажмите «Изменить» (нужен 2FA).
          </p>
          <div className={styles.actions}>
            <button className={styles.btnSecondary} onClick={() => { setEditing(true); setStatus(null); }} disabled={busy}>
              Изменить
            </button>
            <button className={styles.btnSecondary} onClick={testConnection} disabled={busy}>
              Проверить подключение
            </button>
            <button className={styles.btnSecondary} onClick={runDebug} disabled={debugMutation.isPending}>
              Диагностика raw-ответа (admin)
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.hint}>
            Токен создаётся в ЛК МТС: Настройки → «Интеграция по API».
            {configured && ' Текущий токен задан — вставьте новый, чтобы заменить.'}
          </p>
          <div className={styles.field}>
            <label className={styles.label}>Base URL (необязательно)</label>
            <input
              className={styles.input}
              type="text"
              placeholder={connQuery.data?.baseUrl || 'https://api.mpoisk.ru/v6/api'}
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>API-токен</label>
            <input
              className={styles.input}
              type="password"
              autoComplete="off"
              placeholder={connQuery.data?.hasToken ? '•••••••• (задан, вставьте новый для замены)' : 'Вставьте токен'}
              value={token}
              onChange={e => setToken(e.target.value)}
            />
          </div>
          <div className={styles.actions}>
            <button className={styles.btn} onClick={saveConnection} disabled={busy || (!token.trim() && !baseUrl.trim())}>
              Сохранить
            </button>
            {configured && (
              <button
                className={styles.btnSecondary}
                onClick={() => { setToken(''); setBaseUrl(''); setEditing(false); setStatus(null); }}
                disabled={busy}
              >
                Отмена
              </button>
            )}
            <button className={styles.btnSecondary} onClick={testConnection} disabled={busy || !configured}>
              Проверить подключение
            </button>
          </div>
        </>
      )}

      {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}

      {diag && (diag.mtsHttp !== undefined || diag.source !== undefined) && (
        <dl className={styles.diagBlock}>
          <div><dt>baseUrl</dt> <dd>{diag.baseUrl ?? '—'}</dd></div>
          <div><dt>source</dt> <dd>{diag.source ?? '—'}</dd></div>
          <div><dt>hasToken</dt> <dd>{String(diag.hasToken ?? false)}</dd></div>
          {diag.mtsHttp !== undefined && (
            <>
              <div><dt>http</dt> <dd>{diag.mtsHttp}</dd></div>
              <div><dt>mtsCode</dt> <dd>{diag.mtsCode ?? '—'}</dd></div>
              <div><dt>desc</dt> <dd>{diag.mtsDescription ?? '—'}</dd></div>
              <div><dt>message</dt> <dd>{diag.mtsMessage ?? '—'}</dd></div>
            </>
          )}
        </dl>
      )}

      {debugData && (
        <div className={styles.card} style={{ marginTop: 12 }}>
          <h3 className={styles.cardTitle}>Raw-ответ /subscribers (admin diagnostic)</h3>
          <p className={styles.hint}>
            PII-поля (имя, телефон, координаты) скрыты. Видны ключи и типы значений первого абонента.
          </p>
          <div className={styles.field}>
            <label className={styles.label}>Все ключи объекта (topLevelKeys)</label>
            <code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{debugData.topLevelKeys.join(', ')}</code>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Типы значений</label>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
              {JSON.stringify(debugData.valueTypes, null, 2)}
            </pre>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Зачищенный объект</label>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
              {JSON.stringify(debugData.redacted, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
};
