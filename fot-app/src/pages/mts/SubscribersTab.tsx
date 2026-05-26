import { type FC, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMtsSubscribers,
  useMtsSubscribersMeta,
  useMtsLastLocations,
  useMtsMappings,
  useMtsSuggestions,
  useMtsConnectionSettings,
  getMtsSubscribersQueryKey,
  getMtsLocationsQueryKey,
  getMtsMappingsQueryKey,
} from '../../hooks/useMtsData';
import { mtsService, type IMtsSubscriber } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { OsmCoord } from './OsmCoord';
import { EmployeeFioPicker } from './EmployeeFioPicker';
import { MtsRequestLocationModal } from './MtsRequestLocationModal';
import { MtsHistoryModal } from './MtsHistoryModal';
import styles from './MtsPage.module.css';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

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
  return parts.join(' · ');
};

const FRESH_LOC_MS = 15 * 60_000;

export const SubscribersTab: FC = () => {
  const queryClient = useQueryClient();
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const subsQuery = useMtsSubscribers(configured);
  const subsMetaQuery = useMtsSubscribersMeta(configured);
  const locQuery = useMtsLastLocations(configured);
  const mapQuery = useMtsMappings(configured);
  const suggQuery = useMtsSuggestions(configured);

  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [requestSubscriber, setRequestSubscriber] = useState<IMtsSubscriber | null>(null);
  const [historySubscriber, setHistorySubscriber] = useState<IMtsSubscriber | null>(null);

  const locById = useMemo(() => {
    const m = new Map<number, NonNullable<typeof locQuery.data>[number]>();
    for (const l of locQuery.data ?? []) m.set(l.subscriberID, l);
    return m;
  }, [locQuery.data]);

  const mapBySub = useMemo(() => {
    const m = new Map<number, NonNullable<typeof mapQuery.data>[number]>();
    for (const r of mapQuery.data ?? []) m.set(r.subscriberId, r);
    return m;
  }, [mapQuery.data]);

  const filtered = useMemo(() => {
    const all = subsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(s => {
      const phoneFromMap = mapBySub.get(s.subscriberID)?.phone || '';
      return (
        (s.name || '').toLowerCase().includes(q)
        || (s.phone || '').toLowerCase().includes(q)
        || phoneFromMap.toLowerCase().includes(q)
        || String(s.subscriberID).includes(q)
      );
    });
  }, [subsQuery.data, search, mapBySub]);

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

  const refreshLocations = () =>
    queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() });

  return (
    <section className={styles.card}>
      <div className={styles.tableHeader}>
        <h2 className={styles.cardTitle}>
          Абоненты МТС {subsQuery.data ? `(${filtered.length}/${subsQuery.data.length})` : ''}
        </h2>
        <div className={styles.actions}>
          <input
            className={`${styles.input} ${styles.searchInput}`}
            type="search"
            placeholder="Поиск по ФИО, телефону, ID…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            className={styles.btnSecondary}
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: getMtsSubscribersQueryKey() });
              queryClient.invalidateQueries({ queryKey: getMtsLocationsQueryKey() });
            }}
            disabled={busy}
          >
            Обновить
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
        Список номеров (SIM) корпоративного аккаунта МТС. Назначьте каждому абоненту сотрудника FOT
        (вручную табельный номер или «Автоподбор по ФИО»). После привязки сотрудник появится во
        вкладке «Сотрудники».
      </p>

      {subsMetaQuery.data?.meta && (
        <div className={styles.diagInline}>
          <span>В МТС всего: <b>{subsMetaQuery.data.meta.upstreamTotal ?? '—'}</b></span>
          <span>Вам видно: <b>{subsMetaQuery.data.data.length}</b></span>
          <span>Скрыто фильтром доступа: <b>{subsMetaQuery.data.meta.filteredOut ?? 0}</b></span>
          {subsMetaQuery.data.meta.mappingsWithEmployee != null && (
            <span>Привязок (всего/в скоупе): <b>{subsMetaQuery.data.meta.mappingsWithEmployee}/{subsMetaQuery.data.meta.mappingsInScope ?? 0}</b></span>
          )}
        </div>
      )}

      {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}

      {subsQuery.isError && (
        <p className={styles.err}>
          Не удалось загрузить абонентов
          {mtsErrorDetails(subsQuery.error) && <><br /><code>{mtsErrorDetails(subsQuery.error)}</code></>}
        </p>
      )}
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
            {filtered.map(s => {
              const loc = locById.get(s.subscriberID);
              const lat = loc?.latitude ?? s.latitude;
              const lon = loc?.longitude ?? s.longitude;
              const row = mapBySub.get(s.subscriberID);
              const phoneDisplay = s.phone || row?.phone || '—';

              const locRecentMs = loc?.locationDate
                ? Date.now() - new Date(loc.locationDate).getTime()
                : null;
              const isFreshLoc = locRecentMs !== null && locRecentMs <= FRESH_LOC_MS;

              let statusLabel: string;
              let statusClass = styles.statusOffline ?? '';
              if (s.isOnline === true) {
                statusLabel = 'онлайн';
                statusClass = styles.statusOnline ?? '';
              } else if (s.isOnline === null || s.isOnline === undefined) {
                statusLabel = isFreshLoc ? 'свежая позиция' : 'неизв.';
                statusClass = isFreshLoc ? styles.statusOnline ?? '' : '';
              } else {
                statusLabel = isFreshLoc ? 'офлайн, свежая позиция' : 'офлайн';
              }

              return (
                <tr key={s.subscriberID}>
                  <td>{s.name || `#${s.subscriberID}`}</td>
                  <td>{phoneDisplay}</td>
                  <td className={statusClass}>{statusLabel}</td>
                  <td>
                    {lat != null && lon != null ? <OsmCoord lat={lat} lng={lon} /> : '—'}
                  </td>
                  <td>{row?.employeeFullName || '—'}</td>
                  <td>
                    <div className={styles.mapCell}>
                      {row?.employeeId == null ? (
                        <EmployeeFioPicker
                          disabled={busy}
                          onSelect={(id) => applyMapping(s.subscriberID, id)}
                        />
                      ) : (
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
            {subsQuery.isSuccess && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.hint}>
                  {(subsQuery.data?.length ?? 0) === 0
                    ? 'Список пуст. Проверьте подключение или права доступа.'
                    : 'Ничего не найдено по запросу.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {requestSubscriber && (
        <MtsRequestLocationModal
          subscriber={requestSubscriber}
          onClose={() => setRequestSubscriber(null)}
          onConfirmed={() => {
            setStatus({ ok: true, msg: 'Запрос отправлен. Свежая позиция придёт через несколько секунд.' });
          }}
        />
      )}
      {historySubscriber && (
        <MtsHistoryModal subscriber={historySubscriber} onClose={() => setHistorySubscriber(null)} />
      )}
    </section>
  );
};
