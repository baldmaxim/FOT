import { type FC, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Polygon, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import {
  useMtsTrackPoints,
  useMtsGeofences,
  useCreateGeofence,
  useDeleteGeofence,
  useSetGeofenceAssignments,
  useMtsViolations,
} from '../../hooks/useMtsData';
import type { IGeoPoint, IMtsGeofence } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { ModalShell } from '../../components/ui/ModalShell';
import styles from './MtsMapModal.module.css';
import pageStyles from './MtsPage.module.css';

interface IProps {
  target: { employeeId: number; subscriberId: number; fullName: string };
  onClose: () => void;
}

const DEFAULT_CENTER: [number, number] = [55.7558, 37.6173];
const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined)
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const localIso = (d: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const dateRangeForDays = (days: number): { from: string; to: string } => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: localIso(from), to: localIso(to) };
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
  const [days, setDays] = useState(1);
  const range = useMemo(() => dateRangeForDays(days), [days]);
  const dateFromIso = useMemo(() => new Date(range.from).toISOString(), [range.from]);
  const dateToIso = useMemo(() => new Date(range.to).toISOString(), [range.to]);

  const trackQuery = useMtsTrackPoints(target.subscriberId, dateFromIso, dateToIso, true);
  const geofencesQuery = useMtsGeofences(true);
  const violationsQuery = useMtsViolations({ employeeId: target.employeeId, pageSize: 20 }, true);

  const createMutation = useCreateGeofence();
  const deleteMutation = useDeleteGeofence();
  const assignmentsMutation = useSetGeofenceAssignments();

  const [drawingMode, setDrawingMode] = useState(false);
  const [pendingRing, setPendingRing] = useState<IGeoPoint[] | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const trackPoints: IGeoPoint[] = useMemo(
    () => (trackQuery.data ?? []).map(p => ({ lat: p.lat, lng: p.lng })),
    [trackQuery.data],
  );

  const allGeofences = useMemo(() => geofencesQuery.data ?? [], [geofencesQuery.data]);
  const assignedGeofences = useMemo(
    () => allGeofences.filter(g => g.employeeIds.includes(target.employeeId)),
    [allGeofences, target.employeeId],
  );
  const polygonsForFit = useMemo(
    () => assignedGeofences.map(g => g.geometry),
    [assignedGeofences],
  );

  const center: [number, number] = trackPoints.length > 0
    ? [trackPoints[0].lat, trackPoints[0].lng]
    : DEFAULT_CENTER;

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
              <label className={pageStyles.label}>Период треков</label>
              <div className={pageStyles.actions}>
                {[1, 3, 7].map(d => (
                  <button
                    key={d}
                    className={d === days ? pageStyles.btn : pageStyles.btnSecondary}
                    onClick={() => setDays(d)}
                  >
                    {d} д
                  </button>
                ))}
              </div>
              <p className={pageStyles.hint}>
                Точек на карте: {trackPoints.length}
                {trackQuery.isFetching && ' · загрузка…'}
              </p>
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
              <h4 className={styles.subTitle}>Нарушения (последние)</h4>
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
            </div>
          </aside>

          <div className={styles.mapWrap}>
            <MapContainer center={center} zoom={12} className={styles.map} scrollWheelZoom>
              <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
              <GeomanControls enabled={drawingMode} onPolygonCreated={handlePolygonCreated} />
              <FitBounds points={trackPoints} polygons={polygonsForFit} />
              {trackPoints.length >= 2 && (
                <Polyline positions={trackPoints.map(p => [p.lat, p.lng]) as L.LatLngTuple[]} color="#2563eb" weight={3} opacity={0.8} />
              )}
              {trackPoints.map((p, i) => (
                <CircleMarker
                  key={`${p.lat}-${p.lng}-${i}`}
                  center={[p.lat, p.lng]}
                  radius={3}
                  pathOptions={{ color: '#1e40af', fillOpacity: 0.7 }}
                />
              ))}
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
        </>
      )}
    </ModalShell>
  );
};
