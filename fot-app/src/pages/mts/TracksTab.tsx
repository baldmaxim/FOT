import { type FC, useMemo, useState } from 'react';
import {
  useMtsRecentTracks,
  useMtsRecentGlobalLocations,
  useMtsMappings,
  useMtsConnectionSettings,
} from '../../hooks/useMtsData';
import { OsmCoord } from './OsmCoord';
import { EmployeeFioPicker } from './EmployeeFioPicker';
import { ApiError } from '../../api/client';
import styles from './MtsPage.module.css';

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

const mtsErrorDetails = (e: unknown): string | null => {
  if (!(e instanceof ApiError)) return null;
  const d = (e.details as { mtsHttp?: number; mtsCode?: number | null; mtsDescription?: string | null } | undefined) ?? {};
  const parts: string[] = [`HTTP ${e.status}`];
  if (d.mtsCode != null) parts.push(`код МТС=${d.mtsCode}`);
  if (d.mtsDescription) parts.push(d.mtsDescription);
  return parts.join(' · ');
};

type SubTab = 'segments' | 'gps';

export const TracksTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const [subTab, setSubTab] = useState<SubTab>('segments');
  const [days, setDays] = useState(1);
  const [employeeFilter, setEmployeeFilter] = useState<{ id: number; label: string } | null>(null);

  const tracksQuery = useMtsRecentTracks(days, configured && subTab === 'segments');
  const gpsQuery = useMtsRecentGlobalLocations(days, configured && subTab === 'gps');
  const mapQuery = useMtsMappings(configured);

  const mapBySub = useMemo(() => {
    const m = new Map<number, NonNullable<typeof mapQuery.data>[number]>();
    for (const r of mapQuery.data ?? []) m.set(r.subscriberId, r);
    return m;
  }, [mapQuery.data]);

  const matchEmployee = (subscriberId: number): boolean => {
    if (!employeeFilter) return true;
    const mapping = mapBySub.get(subscriberId);
    return mapping?.employeeId === employeeFilter.id;
  };

  const filteredTracks = (tracksQuery.data ?? []).filter(t => matchEmployee(t.subscriberID));
  const filteredGps = (gpsQuery.data ?? []).filter(p => matchEmployee(p.subscriberID));

  return (
    <section className={styles.card}>
      <div className={styles.titleRow}>
        <span className={styles.badgeFree}>бесплатно · GET</span>
        <select
          className={styles.daysSelect}
          value={days}
          onChange={e => setDays(Number(e.target.value))}
        >
          <option value={1}>1 день</option>
          <option value={3}>3 дня</option>
          <option value={7}>7 дней</option>
        </select>
      </div>

      <div className={styles.tabsBar} style={{ borderBottom: 'none', marginBottom: 8 }}>
        <button
          className={`${styles.tabBtn} ${subTab === 'segments' ? styles.tabActive : ''}`}
          onClick={() => setSubTab('segments')}
        >
          Сегменты МТС
        </button>
        <button
          className={`${styles.tabBtn} ${subTab === 'gps' ? styles.tabActive : ''}`}
          onClick={() => setSubTab('gps')}
        >
          GPS-точки (Координатор)
        </button>
      </div>

      <div className={styles.actions} style={{ marginBottom: 8 }}>
        {employeeFilter ? (
          <span className={styles.chip}>
            <span className={styles.chipText}>Фильтр: {employeeFilter.label}</span>
            <button className={styles.chipRemove} onClick={() => setEmployeeFilter(null)} aria-label="Сбросить">×</button>
          </span>
        ) : (
          <EmployeeFioPicker
            onSelect={(id, label) => setEmployeeFilter({ id, label: label ?? `#${id}` })}
          />
        )}
      </div>

      {subTab === 'segments' && (
        <>
          {tracksQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить треки
              {mtsErrorDetails(tracksQuery.error) && <><br /><code>{mtsErrorDetails(tracksQuery.error)}</code></>}
            </p>
          )}
          {tracksQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {tracksQuery.isSuccess && filteredTracks.length === 0 && (
            <p className={styles.hint}>Сегментов за период нет.</p>
          )}
          {filteredTracks.length > 0 && (
            <div className={styles.tableWrap}>
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
                  {filteredTracks.map(t => {
                    const mapping = mapBySub.get(t.subscriberID);
                    return (
                      <tr key={t.trackID}>
                        <td>{t.subscriberID}</td>
                        <td>{mapping?.employeeFullName || <span className={styles.hint}>не привязан</span>}</td>
                        <td>
                          <div>{t.startDate ? new Date(t.startDate).toLocaleString('ru-RU') : '—'}</div>
                          {t.startLat != null && t.startLon != null ? (
                            <OsmCoord lat={t.startLat} lng={t.startLon} title={t.startAddress ?? undefined} />
                          ) : <span className={styles.hint}>—</span>}
                        </td>
                        <td>
                          <div>{t.finishDate ? new Date(t.finishDate).toLocaleString('ru-RU') : '—'}</div>
                          {t.finishLat != null && t.finishLon != null ? (
                            <OsmCoord lat={t.finishLat} lng={t.finishLon} title={t.finishAddress ?? undefined} />
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
        </>
      )}

      {subTab === 'gps' && (
        <>
          <p className={styles.hint}>
            Точки с приложения МТС-Координатор на телефоне сотрудника.
          </p>
          {gpsQuery.isError && (
            <p className={styles.err}>
              Не удалось загрузить GPS-точки
              {mtsErrorDetails(gpsQuery.error) && <><br /><code>{mtsErrorDetails(gpsQuery.error)}</code></>}
            </p>
          )}
          {gpsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
          {gpsQuery.isSuccess && filteredGps.length === 0 && (
            <p className={styles.hint}>GPS-точек за период нет.</p>
          )}
          {filteredGps.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>subscriberID</th>
                    <th>Сотрудник FOT</th>
                    <th>Время</th>
                    <th>Координаты</th>
                    <th>Скорость</th>
                    <th>Валидна</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGps.slice(0, 200).map(p => {
                    const mapping = mapBySub.get(p.subscriberID);
                    return (
                      <tr key={p.locationID}>
                        <td>{p.subscriberID}</td>
                        <td>{mapping?.employeeFullName || <span className={styles.hint}>не привязан</span>}</td>
                        <td>{p.locationDate ? new Date(p.locationDate).toLocaleString('ru-RU') : '—'}</td>
                        <td>
                          {p.latitude != null && p.longitude != null ? (
                            <OsmCoord lat={p.latitude} lng={p.longitude} />
                          ) : '—'}
                        </td>
                        <td>{p.velocity != null ? `${Math.round(p.velocity)} км/ч` : '—'}</td>
                        <td>{p.isValid === false ? 'нет' : 'да'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredGps.length > 200 && (
                <p className={styles.hint}>Показаны первые 200 точек из {filteredGps.length}.</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
