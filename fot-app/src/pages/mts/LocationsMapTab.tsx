import { type FC, Fragment, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  useMtsLastLocations,
  useMtsMappings,
  useMtsSubscribers,
  useMtsRecentTracks,
  useMtsConnectionSettings,
} from '../../hooks/useMtsData';
import pageStyles from './MtsPage.module.css';

const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined)
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const DEFAULT_CENTER: [number, number] = [55.7558, 37.6173];

// Цвета для треков (циклически).
const TRACK_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#a855f7', '#f59e0b', '#0891b2'];

// Простые HTML-маркеры (без зависимости от внешних иконок).
const dotIcon = (color: string, size = 22): L.DivIcon =>
  L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

const labelIcon = (text: string, color: string): L.DivIcon =>
  L.divIcon({
    className: '',
    html: `<div style="display:flex;align-items:center;gap:4px;"><div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4);"></div><span style="background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #d1d5db;font-size:11px;font-weight:600;white-space:nowrap;">${text}</span></div>`,
    iconSize: [80, 18],
    iconAnchor: [7, 9],
  });

interface IFitProps {
  points: Array<{ lat: number; lng: number }>;
}

const FitBounds: FC<IFitProps> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]) as L.LatLngTuple[]);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }, [map, points]);
  return null;
};

export const LocationsMapTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  // Режимы: 'last' — последние позиции всех; 'tracks' — треки выбранного сотрудника.
  const [mode, setMode] = useState<'last' | 'tracks'>('last');
  const [days, setDays] = useState(1);
  const [selectedSubscriberId, setSelectedSubscriberId] = useState<number | null>(null);

  const lastQuery = useMtsLastLocations(configured && mode === 'last');
  const subsQuery = useMtsSubscribers(configured);
  const mapQuery = useMtsMappings(configured);
  const tracksQuery = useMtsRecentTracks(days, configured && mode === 'tracks');

  const mapBySub = useMemo(() => {
    const m = new Map<number, NonNullable<typeof mapQuery.data>[number]>();
    for (const r of mapQuery.data ?? []) m.set(r.subscriberId, r);
    return m;
  }, [mapQuery.data]);

  const subById = useMemo(() => {
    const m = new Map<number, NonNullable<typeof subsQuery.data>[number]>();
    for (const s of subsQuery.data ?? []) m.set(s.subscriberID, s);
    return m;
  }, [subsQuery.data]);

  /** Точки для FitBounds в режиме «последние». */
  const lastPoints = useMemo(() => {
    return (lastQuery.data ?? [])
      .filter(l => l.latitude != null && l.longitude != null)
      .map(l => ({ lat: l.latitude as number, lng: l.longitude as number }));
  }, [lastQuery.data]);

  /** Треки выбранного сотрудника (или все, если фильтр не задан). */
  const filteredTracks = useMemo(() => {
    const all = tracksQuery.data ?? [];
    if (selectedSubscriberId === null) return all;
    return all.filter(t => t.subscriberID === selectedSubscriberId);
  }, [tracksQuery.data, selectedSubscriberId]);

  /** Точки для FitBounds в режиме «треки». */
  const trackPoints = useMemo(() => {
    const pts: Array<{ lat: number; lng: number }> = [];
    for (const t of filteredTracks) {
      if (t.startLat != null && t.startLon != null) pts.push({ lat: t.startLat, lng: t.startLon });
      if (t.finishLat != null && t.finishLon != null) pts.push({ lat: t.finishLat, lng: t.finishLon });
    }
    return pts;
  }, [filteredTracks]);

  // Список сотрудников с привязкой для дропдауна выбора.
  const linkedOptions = useMemo(() => {
    const list: Array<{ subscriberId: number; label: string }> = [];
    for (const m of mapQuery.data ?? []) {
      if (m.employeeId == null) continue;
      list.push({
        subscriberId: m.subscriberId,
        label: m.employeeFullName || m.displayName || `Абонент #${m.subscriberId}`,
      });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [mapQuery.data]);

  return (
    <section className={pageStyles.card}>
      <div className={pageStyles.toolbarRow}>
        <div className={pageStyles.actions}>
          <button
            className={mode === 'last' ? pageStyles.btn : pageStyles.btnSecondary}
            onClick={() => setMode('last')}
          >
            Последние позиции всех
          </button>
          <button
            className={mode === 'tracks' ? pageStyles.btn : pageStyles.btnSecondary}
            onClick={() => setMode('tracks')}
          >
            Треки сотрудника
          </button>
        </div>
        {mode === 'tracks' && (
          <div className={pageStyles.actions}>
            <select
              className={pageStyles.daysSelect}
              value={selectedSubscriberId ?? ''}
              onChange={e => setSelectedSubscriberId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Все привязанные</option>
              {linkedOptions.map(o => (
                <option key={o.subscriberId} value={o.subscriberId}>{o.label}</option>
              ))}
            </select>
            <select
              className={pageStyles.daysSelect}
              value={days}
              onChange={e => setDays(Number(e.target.value))}
            >
              <option value={1}>1 день</option>
              <option value={3}>3 дня</option>
              <option value={7}>7 дней</option>
            </select>
          </div>
        )}
      </div>

      <p className={pageStyles.hint}>
        {mode === 'last'
          ? 'Точки на карте — последние известные позиции абонентов из последнего опроса MTS.'
          : 'Каждый трек = пара «Старт → Финиш». Цвета — для разных треков. Полилинии прямые (детальный GPS-маршрут не передаётся в этом эндпоинте).'}
      </p>

      {(lastQuery.isLoading || tracksQuery.isLoading) && <p className={pageStyles.hint}>Загрузка…</p>}
      {mode === 'last' && lastQuery.isError && <p className={pageStyles.err}>Не удалось загрузить позиции</p>}
      {mode === 'tracks' && tracksQuery.isError && <p className={pageStyles.err}>Не удалось загрузить треки</p>}

      <div style={{ height: 'calc(100vh - 320px)', minHeight: 480, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--color-border, #e5e7eb)' }}>
        <MapContainer center={DEFAULT_CENTER} zoom={10} style={{ width: '100%', height: '100%' }} scrollWheelZoom>
          <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
          <FitBounds points={mode === 'last' ? lastPoints : trackPoints} />

          {mode === 'last' && (lastQuery.data ?? []).map(l => {
            if (l.latitude == null || l.longitude == null) return null;
            const sub = subById.get(l.subscriberID);
            const mapping = mapBySub.get(l.subscriberID);
            const label = mapping?.employeeFullName || sub?.name || `#${l.subscriberID}`;
            return (
              <Marker
                key={l.subscriberID}
                position={[l.latitude, l.longitude]}
                icon={dotIcon('#2563eb', 18)}
              >
                <Popup>
                  <div style={{ fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{label}</div>
                    {l.locationDate && (
                      <div style={{ color: '#6b7280' }}>{new Date(l.locationDate).toLocaleString('ru-RU')}</div>
                    )}
                    {l.address && <div style={{ marginTop: 4 }}>{l.address}</div>}
                    <div style={{ marginTop: 4, color: '#6b7280' }}>
                      {l.latitude.toFixed(5)}, {l.longitude.toFixed(5)}
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}

          {mode === 'tracks' && filteredTracks.map((t, idx) => {
            if (t.startLat == null || t.startLon == null || t.finishLat == null || t.finishLon == null) return null;
            const color = TRACK_COLORS[idx % TRACK_COLORS.length];
            const start: L.LatLngTuple = [t.startLat, t.startLon];
            const finish: L.LatLngTuple = [t.finishLat, t.finishLon];
            return (
              <Fragment key={t.trackID}>
                <Polyline
                  positions={[start, finish]}
                  pathOptions={{ color, weight: 3, opacity: 0.85, dashArray: '6,6' }}
                />
                <Marker position={start} icon={labelIcon('Старт', color)}>
                  <Popup>
                    <div style={{ fontSize: 13 }}>
                      <b>Старт</b>
                      <div>{t.startDate ? new Date(t.startDate).toLocaleString('ru-RU') : '—'}</div>
                      {t.startAddress && <div style={{ marginTop: 4 }}>{t.startAddress}</div>}
                    </div>
                  </Popup>
                </Marker>
                <Marker position={finish} icon={labelIcon('Финиш', color)}>
                  <Popup>
                    <div style={{ fontSize: 13 }}>
                      <b>Финиш</b>
                      <div>{t.finishDate ? new Date(t.finishDate).toLocaleString('ru-RU') : '—'}</div>
                      {t.finishAddress && <div style={{ marginTop: 4 }}>{t.finishAddress}</div>}
                    </div>
                  </Popup>
                </Marker>
                <CircleMarker center={start} radius={4} pathOptions={{ color, fillOpacity: 1 }} />
                <CircleMarker center={finish} radius={4} pathOptions={{ color, fillOpacity: 1 }} />
              </Fragment>
            );
          })}
        </MapContainer>
      </div>

      {mode === 'last' && (
        <p className={pageStyles.hint} style={{ marginTop: 8 }}>
          Показано точек: {lastPoints.length} из {lastQuery.data?.length ?? 0} абонентов. Позиции обновляются раз в час фоновым поллером (бесплатно).
        </p>
      )}
      {mode === 'tracks' && (
        <p className={pageStyles.hint} style={{ marginTop: 8 }}>
          Треков: {filteredTracks.length}{selectedSubscriberId !== null ? ` (фильтр по сотруднику)` : ''}.
        </p>
      )}
    </section>
  );
};
