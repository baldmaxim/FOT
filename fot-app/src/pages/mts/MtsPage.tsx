import { type FC, useMemo, useState, lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMtsConnectionSettings,
  useMtsSubscribers,
  useMtsSubscribersMeta,
  useMtsLastLocations,
  useMtsMappings,
  useMtsSuggestions,
  useMtsTasks,
  useMtsSubscriberGroups,
  useMtsCustomFields,
  useMtsRecentTracks,
  useMtsRecentGlobalLocations,
  useMtsEmployeesLinked,
  useAutoLinkMappings,
  getMtsConnectionQueryKey,
  getMtsSubscribersQueryKey,
  getMtsMappingsQueryKey,
  getMtsLocationsQueryKey,
  getMtsTasksQueryKey,
} from '../../hooks/useMtsData';
import { OsmCoord } from './OsmCoord';

const MtsMapModal = lazy(() => import('./MtsMapModal').then(m => ({ default: m.MtsMapModal })));
import { mtsService, type IMtsSubscriber, type IMtsTestResult } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { MtsRequestLocationModal } from './MtsRequestLocationModal';
import { MtsHistoryModal } from './MtsHistoryModal';
import { MtsTaskCreateModal } from './MtsTaskCreateModal';
import styles from './MtsPage.module.css';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

/**
 * Подробная диагностика ошибки секции — статус и поля МТС из error.details,
 * которые бэк прокидывает в payload при апстрим-ошибке.
 */
const mtsErrorDetails = (e: unknown): string | null => {
  if (!(e instanceof ApiError)) return null;
  const d = (e.details as
    | { mtsHttp?: number; mtsCode?: number | null; mtsDescription?: string | null; mtsMessage?: string; internal?: string }
    | undefined) ?? {};
  const parts: string[] = [`HTTP ${e.status}`];
  if (d.mtsHttp !== undefined && d.mtsHttp !== e.status) parts.push(`upstream=${d.mtsHttp}`);
  if (d.mtsCode != null) parts.push(`код МТС=${d.mtsCode}`);
  if (d.mtsDescription) parts.push(d.mtsDescription);
  if (d.mtsMessage && d.mtsMessage !== e.message) parts.push(d.mtsMessage);
  if (d.internal && e.status >= 500) parts.push(d.internal);
  return parts.join(' · ');
};

const fmtDuration = (sec: number | null): string => {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
};

const fmtDistance = (m: number | null): string => {
  if (m == null || !Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`;
};

export const MtsPage: FC = () => {
  const queryClient = useQueryClient();

  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const subsQuery = useMtsSubscribers(configured);
  const subsMetaQuery = useMtsSubscribersMeta(configured);
  const locQuery = useMtsLastLocations(configured);
  const mapQuery = useMtsMappings(configured);
  const suggQuery = useMtsSuggestions(configured);

  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [diag, setDiag] = useState<IMtsTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const [empInputs, setEmpInputs] = useState<Record<number, string>>({});
  const [requestSubscriber, setRequestSubscriber] = useState<IMtsSubscriber | null>(null);
  const [historySubscriber, setHistorySubscriber] = useState<IMtsSubscriber | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [tracksDays, setTracksDays] = useState(1);
  const [gpsDays, setGpsDays] = useState(1);
  const [linkedSearch, setLinkedSearch] = useState('');
  const [mapTarget, setMapTarget] = useState<{ employeeId: number; subscriberId: number; fullName: string } | null>(null);
  const linkedQuery = useMtsEmployeesLinked({ search: linkedSearch, pageSize: 100 }, configured);
  const autoLinkMutation = useAutoLinkMappings();
  const tasksQuery = useMtsTasks(configured);
  const groupsQuery = useMtsSubscriberGroups(configured);
  const customFieldsQuery = useMtsCustomFields(configured);
  const tracksQuery = useMtsRecentTracks(tracksDays, configured);
  const gpsQuery = useMtsRecentGlobalLocations(gpsDays, configured);

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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getMtsConnectionQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ['mts', 'subscribers', 'meta'] }),
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
      // Освежаем основной список — testConnection бьёт МТС напрямую, а кэш
      // React Query мог хранить старый пустой ответ из предыдущей сессии.
      if (r.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: ['mts', 'subscribers', 'meta'] }),
          queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() }),
        ]);
      }
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
      </section>

      {configured && (
        <section className={styles.card}>
          <div className={styles.tableHeader}>
            <h2 className={styles.cardTitle}>
              Привязанные сотрудники — карта и геозоны
              {linkedQuery.data ? ` (${linkedQuery.data.data.length})` : ''}
            </h2>
            <div className={styles.actions}>
              <input
                className={`${styles.input} ${styles.searchInput}`}
                type="search"
                placeholder="Поиск по ФИО…"
                value={linkedSearch}
                onChange={e => setLinkedSearch(e.target.value)}
              />
              <button
                className={styles.btnSecondary}
                disabled={autoLinkMutation.isPending}
                onClick={async () => {
                  setStatus(null);
                  try {
                    const r = await autoLinkMutation.mutateAsync();
                    setStatus({ ok: true, msg: `Авто-привязано по ФИО: ${r.applied}` });
                  } catch (e) {
                    setStatus({ ok: false, msg: errText(e, 'Ошибка авто-привязки (нужен 2FA)') });
                  }
                }}
              >
                Авто-привязка по ФИО (2FA)
              </button>
            </div>
          </div>
          <p className={styles.hint}>
            Это сотрудники FOT, для которых уже назначена связь с абонентом МТС
            (через раздел «Абоненты МТС» ниже). По кнопке «Карта» — треки на OpenStreetMap и настройка геозон.
            Уведомление администратору приходит, если сотрудник вне геозоны во время своей смены.
          </p>
          {linkedQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {linkedQuery.isError && <p className={styles.err}>Не удалось загрузить список</p>}
          {linkedQuery.isSuccess && linkedQuery.data.data.length === 0 && (
            <p className={styles.hint}>
              Привязок пока нет. Спуститесь к разделу «Абоненты МТС» ниже — там назначьте каждому абоненту сотрудника FOT
              (вручную по табельному номеру или массово «Авто-привязка по ФИО» сверху). После сохранения
              сотрудники появятся здесь.
            </p>
          )}
          {linkedQuery.data && linkedQuery.data.data.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ФИО</th>
                    <th>Таб.№</th>
                    <th>Телефон МТС</th>
                    <th>Последний пинг</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {linkedQuery.data.data.map(row => (
                    <tr key={row.subscriberId}>
                      <td>{row.employeeFullName || row.displayName || `#${row.employeeId}`}</td>
                      <td>{row.employeeTabNumber || '—'}</td>
                      <td>{row.phone || '—'}</td>
                      <td>{row.lastRecordedAt ? new Date(row.lastRecordedAt).toLocaleString('ru-RU') : '—'}</td>
                      <td>
                        <button
                          className={styles.btnSm}
                          disabled={!row.employeeId}
                          onClick={() => {
                            if (!row.employeeId) return;
                            setMapTarget({
                              employeeId: row.employeeId,
                              subscriberId: row.subscriberId,
                              fullName: row.employeeFullName || row.displayName || `#${row.employeeId}`,
                            });
                          }}
                        >
                          Карта
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {mapTarget && (
        <Suspense fallback={<div />}>
          <MtsMapModal target={mapTarget} onClose={() => setMapTarget(null)} />
        </Suspense>
      )}

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
              Абоненты МТС — назначение сотрудников FOT {subsQuery.data ? `(${subsQuery.data.length})` : ''}
            </h2>
            <div className={styles.actions}>
              <button
                className={styles.btnSecondary}
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() });
                  queryClient.invalidateQueries({ queryKey: ['mts', 'subscribers', 'meta'] });
                  queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() });
                }}
                disabled={busy}
              >
                Обновить список
              </button>
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

          <p className={styles.hint}>
            <b>Что это.</b> Список всех номеров (SIM-карт) из вашего корпоративного аккаунта МТС.
            Чтобы система знала, кому принадлежит каждый номер, — назначьте каждому абоненту
            соответствующего сотрудника FOT. Это похоже на «одобрение» нового пользователя и
            привязку его к карте Sigur: один раз указываете соответствие — дальше треки и геозоны
            работают автоматически.
            <br />
            <b>Как назначить.</b> 1) Кнопка «Авто-привязка по ФИО» сверху — пакетно по точному
            совпадению. 2) Вручную в строке: ввести табельный номер сотрудника FOT и нажать «Привязать».
            После привязки сотрудник появится в разделе «Привязанные сотрудники» выше.
          </p>

          {subsMetaQuery.data?.meta && (
            <div className={styles.diagInline}>
              <span>В МТС всего: <b>{subsMetaQuery.data.meta.upstreamTotal ?? '—'}</b></span>
              <span>Вам видно: <b>{subsMetaQuery.data.data.length}</b></span>
              <span>Скрыто фильтром доступа: <b>{subsMetaQuery.data.meta.filteredOut ?? 0}</b></span>
              <span>Полный доступ: <b>{String(subsMetaQuery.data.meta.hasFullAccess ?? false)}</b></span>
              {subsMetaQuery.data.meta.mappingsWithEmployee != null && (
                <span>Привязок (всего/в скоупе): <b>{subsMetaQuery.data.meta.mappingsWithEmployee}/{subsMetaQuery.data.meta.mappingsInScope ?? 0}</b></span>
              )}
            </div>
          )}

          {subsQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить абонентов
              {mtsErrorDetails(subsQuery.error) && (
                <><br /><code>{mtsErrorDetails(subsQuery.error)}</code></>
              )}
            </p>
          )}
          {subsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {subsQuery.isSuccess && (subsQuery.data?.length ?? 0) === 0 && (
            <p className={styles.hint}>
              Список пуст. Возможные причины:
              <br />· в МТС-аккаунте нет абонентов (проверьте в ЛК M-Poisk);
              <br />· вы не <code>admin</code> — бэк отдаёт только тех абонентов, чьи привязки указывают на сотрудников
              в вашей области доступа. Если привязок ещё нет — попросите системного администратора их создать.
              <br />· проверьте подключение кнопкой «Проверить подключение» — диагностический блок покажет статус и ошибку МТС.
            </p>
          )}

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
                          <OsmCoord lat={lat} lng={lon} />
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

      {configured && (
        <section className={styles.card}>
          <div className={styles.titleRow}>
            <h2 className={styles.cardTitle}>
              Группы абонентов {groupsQuery.data ? `(${groupsQuery.data.length})` : ''}
            </h2>
            <span className={styles.badgeFree}>бесплатно · GET</span>
          </div>
          {groupsQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить группы — остальные разделы работают
              {mtsErrorDetails(groupsQuery.error) && (
                <><br /><code>{mtsErrorDetails(groupsQuery.error)}</code></>
              )}
            </p>
          )}
          {groupsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {groupsQuery.isSuccess && (groupsQuery.data?.length ?? 0) === 0 && (
            <p className={styles.hint}>Групп нет.</p>
          )}
          {(groupsQuery.data?.length ?? 0) > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Название</th>
                    <th>Абонентов в группе</th>
                  </tr>
                </thead>
                <tbody>
                  {(groupsQuery.data ?? []).map(g => {
                    const count = (subsQuery.data ?? []).filter(
                      s => Array.isArray(s.subscriberGroupIDs) && s.subscriberGroupIDs.includes(g.subscriberGroupID),
                    ).length;
                    return (
                      <tr key={g.subscriberGroupID}>
                        <td>{g.subscriberGroupID}</td>
                        <td>{g.name || '—'}</td>
                        <td>{count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {configured && (
        <section className={styles.card}>
          <div className={styles.titleRow}>
            <h2 className={styles.cardTitle}>
              Шаблоны кастомных полей {customFieldsQuery.data ? `(${customFieldsQuery.data.length})` : ''}
            </h2>
            <span className={styles.badgeFree}>бесплатно · GET</span>
          </div>
          {customFieldsQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить кастомные поля — остальные разделы работают
              {mtsErrorDetails(customFieldsQuery.error) && (
                <><br /><code>{mtsErrorDetails(customFieldsQuery.error)}</code></>
              )}
            </p>
          )}
          {customFieldsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {customFieldsQuery.isSuccess && (customFieldsQuery.data?.length ?? 0) === 0 && (
            <p className={styles.hint}>Кастомных полей нет.</p>
          )}
          {(customFieldsQuery.data?.length ?? 0) > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Название</th>
                    <th>Тип</th>
                    <th>Обязательное</th>
                  </tr>
                </thead>
                <tbody>
                  {(customFieldsQuery.data ?? []).map((f, idx) => (
                    <tr key={f.customFieldID ?? idx}>
                      <td>{f.customFieldID ?? '—'}</td>
                      <td>{f.name || '—'}</td>
                      <td>{f.type || '—'}</td>
                      <td>{f.isRequired ? 'да' : 'нет'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {configured && (
        <section className={styles.card}>
          <div className={styles.titleRow}>
            <h2 className={styles.cardTitle}>
              Треки за период {tracksQuery.data ? `(${tracksQuery.data.length})` : ''}
            </h2>
            <span className={styles.badgeFree}>бесплатно · GET</span>
            <select
              className={styles.daysSelect}
              value={tracksDays}
              onChange={e => setTracksDays(Number(e.target.value))}
              disabled={tracksQuery.isFetching}
            >
              <option value={1}>1 день</option>
              <option value={3}>3 дня</option>
              <option value={7}>7 дней</option>
            </select>
          </div>
          {tracksQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить треки — остальные разделы работают
              {mtsErrorDetails(tracksQuery.error) && (
                <><br /><code>{mtsErrorDetails(tracksQuery.error)}</code></>
              )}
            </p>
          )}
          {tracksQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {tracksQuery.isSuccess && (tracksQuery.data?.length ?? 0) === 0 && (
            <p className={styles.hint}>Треков за период нет.</p>
          )}
          {(tracksQuery.data?.length ?? 0) > 0 && (
            <div className={styles.tableWrap}>
              <p className={styles.hint}>
                Это агрегированные сегменты МТС (старт→финиш), а не «сырой» трек GPS-движения.
                Для отрисовки реального трека на карте откройте раздел «Сотрудники с MTS-привязкой» → кнопка «Карта».
              </p>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>subscriberID</th>
                    <th>Сотрудник FOT</th>
                    <th>Старт</th>
                    <th>Финиш</th>
                    <th>Расстояние</th>
                    <th>Длительность</th>
                  </tr>
                </thead>
                <tbody>
                  {(tracksQuery.data ?? []).map(t => {
                    const sLat = t.startLat;
                    const sLon = t.startLon;
                    const fLat = t.finishLat;
                    const fLon = t.finishLon;
                    const mappingRow = mapBySub.get(t.subscriberID);
                    return (
                      <tr key={t.trackID}>
                        <td>{t.subscriberID}</td>
                        <td>{mappingRow?.employeeFullName || <span className={styles.hint}>не привязан</span>}</td>
                        <td>
                          <div>{t.startDate ? new Date(t.startDate).toLocaleString('ru-RU') : '—'}</div>
                          {sLat != null && sLon != null ? (
                            <OsmCoord lat={sLat} lng={sLon} title={t.startAddress ?? undefined} />
                          ) : <span className={styles.hint}>—</span>}
                        </td>
                        <td>
                          <div>{t.finishDate ? new Date(t.finishDate).toLocaleString('ru-RU') : '—'}</div>
                          {fLat != null && fLon != null ? (
                            <OsmCoord lat={fLat} lng={fLon} title={t.finishAddress ?? undefined} />
                          ) : <span className={styles.hint}>—</span>}
                        </td>
                        <td>{fmtDistance(t.distance)}</td>
                        <td>{fmtDuration(t.duration)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {configured && (
        <section className={styles.card}>
          <div className={styles.titleRow}>
            <h2 className={styles.cardTitle}>
              GPS-точки за период {gpsQuery.data ? `(${gpsQuery.data.length})` : ''}
            </h2>
            <span className={styles.badgeFree}>бесплатно · GET</span>
            <select
              className={styles.daysSelect}
              value={gpsDays}
              onChange={e => setGpsDays(Number(e.target.value))}
              disabled={gpsQuery.isFetching}
            >
              <option value={1}>1 день</option>
              <option value={3}>3 дня</option>
              <option value={7}>7 дней</option>
            </select>
          </div>
          <p className={styles.hint}>
            Данные с приложения МТС-Координатор на телефоне сотрудника. Получение из МТС — бесплатно.
          </p>
          {gpsQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить GPS-точки — остальные разделы работают
              {mtsErrorDetails(gpsQuery.error) && (
                <><br /><code>{mtsErrorDetails(gpsQuery.error)}</code></>
              )}
            </p>
          )}
          {gpsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {gpsQuery.isSuccess && (gpsQuery.data?.length ?? 0) === 0 && (
            <p className={styles.hint}>GPS-точек за период нет.</p>
          )}
          {(gpsQuery.data?.length ?? 0) > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>subscriberID</th>
                    <th>Время</th>
                    <th>Координаты</th>
                    <th>Скорость</th>
                    <th>Валидна</th>
                  </tr>
                </thead>
                <tbody>
                  {(gpsQuery.data ?? []).slice(0, 200).map(p => (
                    <tr key={p.locationID}>
                      <td>{p.subscriberID}</td>
                      <td>{p.locationDate ? new Date(p.locationDate).toLocaleString('ru-RU') : '—'}</td>
                      <td>
                        {p.latitude != null && p.longitude != null ? (
                          <OsmCoord lat={p.latitude} lng={p.longitude} />
                        ) : '—'}
                      </td>
                      <td>{p.velocity != null ? `${Math.round(p.velocity)} км/ч` : '—'}</td>
                      <td>{p.isValid === false ? 'нет' : 'да'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(gpsQuery.data?.length ?? 0) > 200 && (
                <p className={styles.hint}>Показаны первые 200 точек из {gpsQuery.data?.length}.</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
