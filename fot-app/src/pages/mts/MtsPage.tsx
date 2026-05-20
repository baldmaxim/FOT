import { type FC, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMtsConnectionSettings,
  useMtsSubscribers,
  useMtsLastLocations,
  useMtsMappings,
  useMtsSuggestions,
  useMtsTasks,
  getMtsConnectionQueryKey,
  getMtsMappingsQueryKey,
  getMtsLocationsQueryKey,
  getMtsTasksQueryKey,
} from '../../hooks/useMtsData';
import { mtsService, type IMtsSubscriber } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { MtsRequestLocationModal } from './MtsRequestLocationModal';
import { MtsHistoryModal } from './MtsHistoryModal';
import { MtsTaskCreateModal } from './MtsTaskCreateModal';
import styles from './MtsPage.module.css';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

export const MtsPage: FC = () => {
  const queryClient = useQueryClient();

  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const subsQuery = useMtsSubscribers(configured);
  const locQuery = useMtsLastLocations(configured);
  const mapQuery = useMtsMappings(configured);
  const suggQuery = useMtsSuggestions(configured);

  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const [empInputs, setEmpInputs] = useState<Record<number, string>>({});
  const [requestSubscriber, setRequestSubscriber] = useState<IMtsSubscriber | null>(null);
  const [historySubscriber, setHistorySubscriber] = useState<IMtsSubscriber | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const tasksQuery = useMtsTasks(configured);

  const locData = locQuery.data;
  const mapData = mapQuery.data;

  const locById = useMemo(() => {
    const m = new Map<number, NonNullable<typeof locData>[number]>();
    for (const l of locData ?? []) m.set(l.subscriberID, l);
    return m;
  }, [locData]);

  const mapBySub = useMemo(() => {
    const m = new Map<number, NonNullable<typeof mapData>[number]>();
    for (const r of mapData ?? []) m.set(r.subscriberId, r);
    return m;
  }, [mapData]);

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
      setEditingConnection(false);
      await queryClient.invalidateQueries({ queryKey: getMtsConnectionQueryKey() });
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
    try {
      const r = await mtsService.testConnection();
      setStatus(
        r.ok
          ? { ok: true, msg: `Подключение успешно. Абонентов: ${r.count}` }
          : { ok: false, msg: r.error || 'Подключение не удалось' },
      );
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка проверки подключения') });
    } finally {
      setBusy(false);
    }
  };

  const refreshLocations = () =>
    queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() });

  const applyMapping = async (subscriberId: number, employeeId: number | null) => {
    setBusy(true);
    setStatus(null);
    try {
      const sub = (subsQuery.data ?? []).find(s => s.subscriberID === subscriberId);
      await mtsService.setMapping({
        subscriberId,
        employeeId,
        phone: sub?.phone ?? null,
        displayName: sub?.name ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: getMtsMappingsQueryKey() });
      setStatus({ ok: true, msg: 'Привязка обновлена' });
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка привязки') });
    } finally {
      setBusy(false);
    }
  };

  const applyAllSuggestions = async () => {
    const list = suggQuery.data ?? [];
    if (list.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      for (const s of list) {
        const sub = (subsQuery.data ?? []).find(x => x.subscriberID === s.subscriberId);
        await mtsService.setMapping({
          subscriberId: s.subscriberId,
          employeeId: s.employeeId,
          phone: sub?.phone ?? null,
          displayName: sub?.name ?? null,
        });
      }
      await queryClient.invalidateQueries({ queryKey: getMtsMappingsQueryKey() });
      setStatus({ ok: true, msg: `Применено привязок: ${list.length}` });
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка автоподбора') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Подключение МТС «Мобильные сотрудники»</h2>

        {configured && !editingConnection ? (
          <>
            <p className={styles.ok}>
              ✓ Подключение настроено. Токен задан, источник:{' '}
              <b>{connQuery.data?.source ?? '—'}</b>. Base URL:{' '}
              <code>{connQuery.data?.baseUrl}</code>
            </p>
            <p className={styles.hint}>
              Токен хранится в БД зашифрованным (AES-256-GCM). Чтобы заменить — нажмите
              «Изменить». При сохранении потребуется код 2FA.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.btnSecondary}
                onClick={() => {
                  setEditingConnection(true);
                  setStatus(null);
                }}
                disabled={busy}
              >
                Изменить
              </button>
              <button className={styles.btnSecondary} onClick={testConnection} disabled={busy}>
                Проверить подключение
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.hint}>
              Токен создаётся в ЛК МТС: Настройки → «Интеграция по API». В БД токен хранится
              зашифрованным.
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
              <button
                className={styles.btn}
                onClick={saveConnection}
                disabled={busy || (!token.trim() && !baseUrl.trim())}
              >
                Сохранить
              </button>
              {configured && (
                <button
                  className={styles.btnSecondary}
                  onClick={() => {
                    setToken('');
                    setBaseUrl('');
                    setEditingConnection(false);
                    setStatus(null);
                  }}
                  disabled={busy}
                >
                  Отмена
                </button>
              )}
              <button
                className={styles.btnSecondary}
                onClick={testConnection}
                disabled={busy || !configured}
              >
                Проверить подключение
              </button>
            </div>
          </>
        )}

        {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}
      </section>

      {requestSubscriber && (
        <MtsRequestLocationModal
          subscriber={requestSubscriber}
          onClose={() => setRequestSubscriber(null)}
          onConfirmed={() => {
            setStatus({
              ok: true,
              msg: 'Запрос отправлен. Свежая позиция появится при следующем обновлении lastLocations (обычно несколько секунд).',
            });
          }}
        />
      )}
      {historySubscriber && (
        <MtsHistoryModal subscriber={historySubscriber} onClose={() => setHistorySubscriber(null)} />
      )}
      {taskModalOpen && (
        <MtsTaskCreateModal
          subscribers={subsQuery.data ?? []}
          onClose={() => setTaskModalOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: getMtsTasksQueryKey() });
            setStatus({ ok: true, msg: 'Задача создана в МТС и сохранена локально (шифр).' });
          }}
        />
      )}

      {!configured ? (
        <section className={styles.card}>
          <p className={styles.hint}>Укажите токен, чтобы загрузить абонентов и геопозиции.</p>
        </section>
      ) : (
        <section className={styles.card}>
          <div className={styles.tableHeader}>
            <h2 className={styles.cardTitle}>
              Абоненты {subsQuery.data ? `(${subsQuery.data.length})` : ''}
            </h2>
            <div className={styles.actions}>
              <button className={styles.btnSecondary} onClick={refreshLocations} disabled={busy}>
                Обновить геопозиции
              </button>
              <button
                className={styles.btnSecondary}
                onClick={applyAllSuggestions}
                disabled={busy || (suggQuery.data?.length ?? 0) === 0}
              >
                Автоподбор по ФИО ({suggQuery.data?.length ?? 0})
              </button>
            </div>
          </div>

          {subsQuery.isError && <p className={styles.err}>Не удалось загрузить абонентов</p>}
          {subsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Абонент (МТС)</th>
                  <th>Телефон</th>
                  <th>Статус</th>
                  <th>Позиция</th>
                  <th>Сотрудник FOT</th>
                  <th>Привязка</th>
                </tr>
              </thead>
              <tbody>
                {(subsQuery.data ?? []).map(s => {
                  const loc = locById.get(s.subscriberID);
                  const lat = loc?.latitude ?? s.latitude;
                  const lon = loc?.longitude ?? s.longitude;
                  const row = mapBySub.get(s.subscriberID);
                  return (
                    <tr key={s.subscriberID}>
                      <td>{s.name || `#${s.subscriberID}`}</td>
                      <td>{s.phone || '—'}</td>
                      <td>{s.isOnline ? 'онлайн' : 'офлайн'}</td>
                      <td>
                        {lat != null && lon != null ? (
                          <a
                            className={styles.link}
                            href={`https://yandex.ru/maps/?pt=${lon},${lat}&z=16&l=map`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {lat.toFixed(5)}, {lon.toFixed(5)}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{row?.employeeFullName || '—'}</td>
                      <td>
                        <div className={styles.mapCell}>
                          <input
                            className={styles.inputSm}
                            type="number"
                            placeholder="ID сотр."
                            value={empInputs[s.subscriberID] ?? ''}
                            onChange={e =>
                              setEmpInputs(p => ({ ...p, [s.subscriberID]: e.target.value }))
                            }
                          />
                          <button
                            className={styles.btnSm}
                            disabled={busy || !empInputs[s.subscriberID]}
                            onClick={() =>
                              applyMapping(s.subscriberID, Number(empInputs[s.subscriberID]))
                            }
                          >
                            Привязать
                          </button>
                          {row?.employeeId != null && (
                            <button
                              className={styles.btnSm}
                              disabled={busy}
                              onClick={() => applyMapping(s.subscriberID, null)}
                            >
                              Отвязать
                            </button>
                          )}
                          <button
                            className={styles.btnSm}
                            onClick={() => setHistorySubscriber(s)}
                            title="История перемещений (бесплатно, из БД)"
                          >
                            История
                          </button>
                          <button
                            className={styles.btnDangerSm}
                            onClick={() => setRequestSubscriber(s)}
                            title="Запросить актуальное положение у МТС (ПЛАТНО)"
                          >
                            📍 Запросить (платно)
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {configured && (
        <section className={styles.card}>
          <div className={styles.tableHeader}>
            <h2 className={styles.cardTitle}>
              Задачи МТС {tasksQuery.data ? `(${tasksQuery.data.length})` : ''}
            </h2>
            <div className={styles.actions}>
              <button className={styles.btn} onClick={() => setTaskModalOpen(true)} disabled={busy}>
                + Создать задачу
              </button>
            </div>
          </div>

          {tasksQuery.isError && <p className={styles.err}>Не удалось загрузить задачи</p>}
          {tasksQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>МТС task ID</th>
                  <th>Название</th>
                  <th>Абонент</th>
                  <th>Начало</th>
                  <th>Дедлайн</th>
                  <th>Статус</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(tasksQuery.data ?? []).map(t => (
                  <tr key={t.id}>
                    <td>{t.mtsTaskId ?? '—'}</td>
                    <td>{t.title || '—'}</td>
                    <td>{t.subscriberId ?? '—'}</td>
                    <td>{new Date(t.startDate).toLocaleString('ru-RU')}</td>
                    <td>{t.deadline ? new Date(t.deadline).toLocaleString('ru-RU') : '—'}</td>
                    <td>{t.status || '—'}</td>
                    <td>
                      {t.mtsTaskId != null && (
                        <button
                          className={styles.btnSm}
                          disabled={busy}
                          onClick={async () => {
                            try {
                              setBusy(true);
                              await mtsService.getTask(t.mtsTaskId as number);
                              await queryClient.invalidateQueries({ queryKey: getMtsTasksQueryKey() });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          title="Обновить статус из МТС"
                        >
                          Обновить
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(tasksQuery.data?.length ?? 0) === 0 && tasksQuery.isSuccess && (
                  <tr>
                    <td colSpan={7} className={styles.hint}>Нет задач</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};
