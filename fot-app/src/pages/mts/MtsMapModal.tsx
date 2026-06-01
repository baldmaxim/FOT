import { type FC, Fragment, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Polygon, CircleMarker, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import {
  useMtsTrackDetail,
  useMtsGeofences,
  useCreateGeofence,
  useDeleteGeofence,
  useSetGeofenceAssignments,
  useMtsViolations,
} from '../../hooks/useMtsData';
import type { IGeoPoint, IMtsGeofence } from '../../services/mtsService';
import { DateInput } from '../../components/ui/DateInput';
import { ApiError } from '../../api/client';
import styles from './MtsMapModal.module.css';
import pageStyles from './MtsPage.module.css';

interface IProps {
  target: { employeeId: number; subscriberId: number; fullName: string };
  onClose: () => void;
}

const DEFAULT_CENTER: [number, number] = [55.7558, 37.6173];
const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined)
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Цвета для сегментов треков (циклически).
const TRACK_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#a855f7', '#f59e0b', '#0891b2'];

// HTML-метка «Старт»/«Финиш» для сегментов (как в LocationsMapTab).
const labelIcon = (text: string, color: string): L.DivIcon =>
  L.divIcon({
    className: '',
    html: `<div style="display:flex;align-items:center;gap:4px;"><div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4);"></div><span style="background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #d1d5db;font-size:11px;font-weight:600;white-space:nowrap;">${text}</span></div>`,
    iconSize: [80, 18],
    iconAnchor: [7, 9],
  });

const pad2 = (n: number): string => String(n).padStart(2, '0');
const isoDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shiftDay = (iso: string, delta: number): string => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return isoDay(d);
};

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

interface IGeomanProps {
  enabled: boolean;
  onPolygonCreated: (points: IGeoPoint[]) => void;
}

const GeomanControls: FC<IGeomanProps> = ({ enabled, onPolygonCreated }) => {
  const map = useMap();
  useEffect(() => {
    if (!enabled) return;
    const pm = (map as L.Map & { pm: { addControls: (o: object) => void; removeControls: () => void } }).pm;
    pm.addControls({
      position: 'topleft',
      drawCircle: false,
      drawCircleMarker: false,
      drawMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawText: false,
      cutPolygon: false,
      rotateMode: false,
      editMode: false,
      dragMode: false,
      removalMode: false,
    });
    const handler = (e: { shape?: string; layer: L.Layer }): void => {
      if (e.shape !== 'Polygon') return;
      const layer = e.layer as L.Polygon;
      const ring = (layer.getLatLngs()[0] as L.LatLng[]).map(ll => ({ lat: ll.lat, lng: ll.lng }));
      layer.remove();
      onPolygonCreated(ring);
    };
    map.on('pm:create', handler as unknown as L.LeafletEventHandlerFn);
    return () => {
      map.off('pm:create', handler as unknown as L.LeafletEventHandlerFn);
      pm.removeControls();
    };
  }, [map, enabled, onPolygonCreated]);
  return null;
};

interface IFitProps {
  points: IGeoPoint[];
  polygons: IGeoPoint[][];
}

const FitBounds: FC<IFitProps> = ({ points, polygons }) => {
  const map = useMap();
  useEffect(() => {
    const all: L.LatLngTuple[] = [];
    for (const p of points) all.push([p.lat, p.lng]);
    for (const poly of polygons) for (const p of poly) all.push([p.lat, p.lng]);
    if (all.length === 0) return;
    const bounds = L.latLngBounds(all);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }, [map, points, polygons]);
  return null;
};

export const MtsMapModal: FC<IProps> = ({ target, onClose }) => {
  const [dateFrom, setDateFrom] = useState<string>(() => isoDay(new Date()));
  const [dateTo, setDateTo] = useState<string>(() => isoDay(new Date()));

  const trackQuery = useMtsTrackDetail(target.subscriberId, dateFrom, dateTo, Boolean(dateFrom) && Boolean(dateTo));
  const geofencesQuery = useMtsGeofences(true);

  const allGeofences = useMemo(() => geofencesQuery.data ?? [], [geofencesQuery.data]);
  const assignedGeofences = useMemo(
    () => allGeofences.filter(g => g.employeeIds.includes(target.employeeId)),
    [allGeofences, target.employeeId],
  );
  const assignedIds = useMemo(() => assignedGeofences.map(g => g.id), [assignedGeofences]);

  // Нарушения — только по геозонам, привязанным к сотруднику сейчас (фильтр на бэке).
  const violationsQuery = useMtsViolations(
    { employeeId: target.employeeId, pageSize: 20, geofenceIds: assignedIds },
    true,
  );

  const createMutation = useCreateGeofence();
  const deleteMutation = useDeleteGeofence();
  const assignmentsMutation = useSetGeofenceAssignments();

  const [drawingMode, setDrawingMode] = useState(false);
  const [pendingRing, setPendingRing] = useState<IGeoPoint[] | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  // GPS-точки «Координатора» — плотный реальный маршрут (только валидные).
  const gpsPoints: IGeoPoint[] = useMemo(
    () => (trackQuery.data?.gps ?? [])
      .filter(p => p.isValid !== false && p.latitude != null && p.longitude != null)
      .map(p => ({ lat: p.latitude as number, lng: p.longitude as number })),
    [trackQuery.data],
  );
  const segments = useMemo(() => trackQuery.data?.segments ?? [], [trackQuery.data]);

  // Точки сегментов (старт/финиш) — для FitBounds.
  const segmentPoints: IGeoPoint[] = useMemo(() => {
    const pts: IGeoPoint[] = [];
    for (const t of segments) {
      if (t.startLat != null && t.startLon != null) pts.push({ lat: t.startLat, lng: t.startLon });
      if (t.finishLat != null && t.finishLon != null) pts.push({ lat: t.finishLat, lng: t.finishLon });
    }
    return pts;
  }, [segments]);

  const fitPoints = useMemo(() => [...gpsPoints, ...segmentPoints], [gpsPoints, segmentPoints]);
  const polygonsForFit = useMemo(() => assignedGeofences.map(g => g.geometry), [assignedGeofences]);

  const center: [number, number] = gpsPoints.length > 0
    ? [gpsPoints[0].lat, gpsPoints[0].lng]
    : segmentPoints.length > 0
      ? [segmentPoints[0].lat, segmentPoints[0].lng]
      : DEFAULT_CENTER;

  const hasTrack = gpsPoints.length > 0 || segments.length > 0;

  const handlePolygonCreated = (ring: IGeoPoint[]): void => {
    setPendingRing(ring);
    setDrawingMode(false);
  };

  const savePending = async (): Promise<void> => {
    if (!pendingRing) return;
    const name = pendingName.trim();
    if (!name) {
      setFeedback({ ok: false, msg: 'Укажите название геозоны' });
      return;
    }
    setFeedback(null);
    try {
      const geofence = await createMutation.mutateAsync({ name, geometry: pendingRing });
      // Сразу привязываем к текущему сотруднику.
      await assignmentsMutation.mutateAsync({ id: geofence.id, employeeIds: [target.employeeId] });
      setPendingRing(null);
      setPendingName('');
      setFeedback({ ok: true, msg: `Геозона «${name}» создана и привязана` });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось создать геозону (нужен 2FA)') });
    }
  };

  const toggleAssignment = async (g: IMtsGeofence): Promise<void> => {
    const next = g.employeeIds.includes(target.employeeId)
      ? g.employeeIds.filter(id => id !== target.employeeId)
      : [...g.employeeIds, target.employeeId];
    setFeedback(null);
    try {
      await assignmentsMutation.mutateAsync({ id: g.id, employeeIds: next });
      setFeedback({ ok: true, msg: 'Назначения обновлены' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось обновить назначение (нужен 2FA)') });
    }
  };

  const removeGeofence = async (g: IMtsGeofence): Promise<void> => {
    setFeedback(null);
    try {
      await deleteMutation.mutateAsync(g.id);
      setFeedback({ ok: true, msg: `Геозона «${g.name}» удалена` });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось удалить геозону (нужен 2FA)') });
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Карта МТС">
        <div className={styles.header}>
          <h3 className={styles.title}>{target.fullName} — карта и геозоны</h3>
          <button className={pageStyles.btnSm} onClick={onClose}>Закрыть</button>
        </div>

        <div className={styles.body}>
          <aside className={styles.sidebar}>
            <div className={styles.section}>
              <label className={pageStyles.label}>Дата трека</label>
              <div className={styles.dateNav}>
                <button
                  className={pageStyles.btnSm}
                  onClick={() => { setDateFrom(d => shiftDay(d, -1)); setDateTo(d => shiftDay(d, -1)); }}
                  title="Предыдущий день"
                >
                  ◀
                </button>
                <button
                  className={pageStyles.btnSm}
                  onClick={() => { const t = isoDay(new Date()); setDateFrom(t); setDateTo(t); }}
                >
                  Сегодня
                </button>
                <button
                  className={pageStyles.btnSm}
                  onClick={() => { setDateFrom(d => shiftDay(d, 1)); setDateTo(d => shiftDay(d, 1)); }}
                  title="Следующий день"
                >
                  ▶
                </button>
              </div>
              <div className={styles.dateRow}>
                <label className={styles.dateField}>
                  <span>С</span>
                  <DateInput value={dateFrom} onChange={setDateFrom} />
                </label>
                <label className={styles.dateField}>
                  <span>По</span>
                  <DateInput value={dateTo} onChange={setDateTo} />
                </label>
              </div>
              <p className={pageStyles.hint}>
                GPS-точек: {gpsPoints.length} · сегментов: {segments.length}
                {trackQuery.isFetching && ' · загрузка…'}
              </p>
              {trackQuery.isError && <p className={pageStyles.err}>Не удалось загрузить трек</p>}
              {trackQuery.isSuccess && !hasTrack && (
                <p className={pageStyles.hint}>Нет данных трека за выбранную дату.</p>
              )}
            </div>

            <div className={styles.section}>
              <h4 className={styles.subTitle}>Геозоны</h4>
              <div className={pageStyles.actions}>
                <button
                  className={drawingMode ? pageStyles.btn : pageStyles.btnSecondary}
                  onClick={() => setDrawingMode(v => !v)}
                  disabled={createMutation.isPending}
                >
                  {drawingMode ? 'Отменить рисование' : 'Нарисовать зону'}
                </button>
              </div>
              {pendingRing && (
                <div className={styles.pendingBox}>
                  <p className={pageStyles.hint}>
                    Полигон нарисован ({pendingRing.length} точек). Назовите и сохраните — это потребует 2FA.
                  </p>
                  <input
                    className={pageStyles.input}
                    type="text"
                    placeholder="Название зоны"
                    value={pendingName}
                    onChange={e => setPendingName(e.target.value)}
                  />
                  <div className={pageStyles.actions}>
                    <button
                      className={pageStyles.btn}
                      onClick={savePending}
                      disabled={createMutation.isPending || assignmentsMutation.isPending}
                    >
                      Сохранить
                    </button>
                    <button
                      className={pageStyles.btnSecondary}
                      onClick={() => { setPendingRing(null); setPendingName(''); }}
                    >
                      Отбросить
                    </button>
                  </div>
                </div>
              )}
              <ul className={styles.geofenceList}>
                {allGeofences.map(g => {
                  const assigned = g.employeeIds.includes(target.employeeId);
                  return (
                    <li key={g.id} className={assigned ? styles.itemAssigned : styles.item}>
                      <div className={styles.itemRow}>
                        <span className={styles.itemName}>{g.name}</span>
                        <span className={pageStyles.hint}>{g.geometry.length} точек</span>
                      </div>
                      <div className={pageStyles.actions}>
                        <button className={pageStyles.btnSm} onClick={() => toggleAssignment(g)} disabled={assignmentsMutation.isPending}>
                          {assigned ? 'Отвязать' : 'Привязать'}
                        </button>
                        <button className={pageStyles.btnSm} onClick={() => removeGeofence(g)} disabled={deleteMutation.isPending}>
                          Удалить
                        </button>
                      </div>
                    </li>
                  );
                })}
                {allGeofences.length === 0 && <p className={pageStyles.hint}>Пока геозон нет</p>}
              </ul>
              {feedback && <p className={feedback.ok ? pageStyles.ok : pageStyles.err}>{feedback.msg}</p>}
            </div>

            <div className={styles.section}>
              <h4 className={styles.subTitle}>Нарушения (по привязанным зонам)</h4>
              {assignedGeofences.length === 0 ? (
                <p className={pageStyles.hint}>Нет привязанных геозон.</p>
              ) : (
                <>
                  {(violationsQuery.data?.data ?? []).slice(0, 10).map(v => (
                    <div key={v.id} className={styles.violation}>
                      <div><b>{v.geofenceName || '—'}</b></div>
                      <div className={pageStyles.hint}>
                        {new Date(v.startedAt).toLocaleString('ru-RU')}
                        {v.endedAt ? ' → закрыто' : ' · открыто'}
                      </div>
                    </div>
                  ))}
                  {(violationsQuery.data?.data ?? []).length === 0 && (
                    <p className={pageStyles.hint}>Нарушений нет</p>
                  )}
                </>
              )}
            </div>
          </aside>

          <div className={styles.mapWrap}>
            <MapContainer center={center} zoom={12} className={styles.map} scrollWheelZoom attributionControl={false}>
              <TileLayer url={TILE_URL} maxZoom={19} />
              <GeomanControls enabled={drawingMode} onPolygonCreated={handlePolygonCreated} />
              <FitBounds points={fitPoints} polygons={polygonsForFit} />

              {/* GPS-маршрут (Координатор) */}
              {gpsPoints.length >= 2 && (
                <Polyline positions={gpsPoints.map(p => [p.lat, p.lng]) as L.LatLngTuple[]} color="#2563eb" weight={3} opacity={0.8} />
              )}
              {gpsPoints.map((p, i) => (
                <CircleMarker
                  key={`gps-${i}`}
                  center={[p.lat, p.lng]}
                  radius={3}
                  pathOptions={{ color: '#1e40af', fillOpacity: 0.7 }}
                />
              ))}

              {/* Сегменты Старт→Финиш */}
              {segments.map((t, idx) => {
                if (t.startLat == null || t.startLon == null || t.finishLat == null || t.finishLon == null) return null;
                const color = TRACK_COLORS[idx % TRACK_COLORS.length];
                const start: L.LatLngTuple = [t.startLat, t.startLon];
                const finish: L.LatLngTuple = [t.finishLat, t.finishLon];
                return (
                  <Fragment key={`seg-${t.trackID}`}>
                    <Polyline positions={[start, finish]} pathOptions={{ color, weight: 3, opacity: 0.85, dashArray: '6,6' }} />
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
                  </Fragment>
                );
              })}

              {allGeofences.map(g => {
                const isAssigned = g.employeeIds.includes(target.employeeId);
                return (
                  <Polygon
                    key={g.id}
                    positions={g.geometry.map(p => [p.lat, p.lng]) as L.LatLngTuple[]}
                    pathOptions={{
                      color: isAssigned ? '#16a34a' : '#94a3b8',
                      weight: 2,
                      fillOpacity: isAssigned ? 0.18 : 0.08,
                    }}
                  />
                );
              })}
            </MapContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
