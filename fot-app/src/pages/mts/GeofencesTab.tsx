import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import {
  useMtsGeofences,
  useMtsSkudObjectsLite,
  useMtsConnectionSettings,
  useCreateGeofence,
  useUpdateGeofence,
  useDeleteGeofence,
  useSetGeofenceObjects,
} from '../../hooks/useMtsData';
import type { IGeoPoint, IMtsGeofence } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { GeofenceMultiSelect } from './GeofenceMultiSelect';
import pageStyles from './MtsPage.module.css';
import styles from './GeofencesTab.module.css';

const DEFAULT_CENTER: [number, number] = [55.7558, 37.6173];
const TILE_URL = (import.meta.env.VITE_MAP_TILE_URL as string | undefined)
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

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
  polygons: IGeoPoint[][];
}

const FitBounds: FC<IFitProps> = ({ polygons }) => {
  const map = useMap();
  useEffect(() => {
    const all: L.LatLngTuple[] = [];
    for (const poly of polygons) for (const p of poly) all.push([p.lat, p.lng]);
    if (all.length === 0) return;
    const bounds = L.latLngBounds(all);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  }, [map, polygons]);
  return null;
};

/**
 * Один полигон геозоны на карте. Поддерживает режим редактирования геометрии
 * через Geoman (pm.enable). При drag вершин — onGeometryChange получает новый
 * массив координат; сохранение делает родитель (по кнопке).
 */
interface IPolygonProps {
  g: IMtsGeofence;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onGeometryChange: (ring: IGeoPoint[]) => void;
}

const EditableGeofencePolygon: FC<IPolygonProps> = ({ g, isSelected, isEditing, onSelect, onGeometryChange }) => {
  const ref = useRef<L.Polygon | null>(null);

  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const lyr = layer as unknown as { pm: { enable: (o?: object) => void; disable: () => void } };
    if (isEditing) {
      lyr.pm.enable({ allowSelfIntersection: false });
      const onEdit = (): void => {
        const ring = (layer.getLatLngs()[0] as L.LatLng[]).map(ll => ({ lat: ll.lat, lng: ll.lng }));
        onGeometryChange(ring);
      };
      layer.on('pm:edit', onEdit);
      layer.on('pm:markerdragend', onEdit);
      return () => {
        layer.off('pm:edit', onEdit);
        layer.off('pm:markerdragend', onEdit);
        lyr.pm.disable();
      };
    }
    lyr.pm.disable();
  }, [isEditing, onGeometryChange]);

  return (
    <Polygon
      ref={ref}
      positions={g.geometry.map(p => [p.lat, p.lng]) as L.LatLngTuple[]}
      pathOptions={{
        color: isEditing ? '#f59e0b' : isSelected ? '#2563eb' : g.isActive ? '#16a34a' : '#94a3b8',
        weight: isSelected || isEditing ? 3 : 2,
        fillOpacity: isSelected ? 0.25 : 0.15,
        dashArray: isEditing ? '5,5' : undefined,
      }}
      eventHandlers={{ click: onSelect }}
    />
  );
};

export const GeofencesTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const geofencesQuery = useMtsGeofences(configured);
  const objectsQuery = useMtsSkudObjectsLite(configured);

  const createMutation = useCreateGeofence();
  const updateMutation = useUpdateGeofence();
  const deleteMutation = useDeleteGeofence();
  const setObjectsMutation = useSetGeofenceObjects();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingGeometryId, setEditingGeometryId] = useState<string | null>(null);
  const [editedRing, setEditedRing] = useState<IGeoPoint[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pendingRing, setPendingRing] = useState<IGeoPoint[] | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const all = geofencesQuery.data ?? [];
  const polygonsForFit = useMemo(() => all.map(g => g.geometry), [all]);

  const objectsById = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const o of objectsQuery.data ?? []) m.set(o.id, o);
    return m;
  }, [objectsQuery.data]);

  const toggleCard = (g: IMtsGeofence): void => {
    if (selectedId === g.id) {
      // Повторный клик — свернуть карточку.
      setSelectedId(null);
      // Если включён режим редактирования — отменить.
      if (editingGeometryId === g.id) {
        setEditingGeometryId(null);
        setEditedRing(null);
      }
    } else {
      setSelectedId(g.id);
      setRenameDraft(g.name);
    }
  };

  const handlePolygonCreated = (ring: IGeoPoint[]): void => {
    setPendingRing(ring);
    setDrawing(false);
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
      const g = await createMutation.mutateAsync({ name, geometry: pendingRing });
      setPendingRing(null);
      setPendingName('');
      setSelectedId(g.id);
      setFeedback({ ok: true, msg: `Геозона «${name}» создана` });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось создать (нужен 2FA)') });
    }
  };

  const remove = async (g: IMtsGeofence): Promise<void> => {
    if (!confirm(`Удалить геозону «${g.name}»?`)) return;
    setFeedback(null);
    try {
      await deleteMutation.mutateAsync(g.id);
      if (selectedId === g.id) setSelectedId(null);
      if (editingGeometryId === g.id) { setEditingGeometryId(null); setEditedRing(null); }
      setFeedback({ ok: true, msg: 'Удалено' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось удалить (нужен 2FA)') });
    }
  };

  const rename = async (g: IMtsGeofence, newName: string): Promise<void> => {
    setFeedback(null);
    try {
      await updateMutation.mutateAsync({ id: g.id, input: { name: newName } });
      setFeedback({ ok: true, msg: 'Имя обновлено' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось переименовать (нужен 2FA)') });
    }
  };

  const toggleActive = async (g: IMtsGeofence): Promise<void> => {
    setFeedback(null);
    try {
      await updateMutation.mutateAsync({ id: g.id, input: { isActive: !g.isActive } });
      setFeedback({ ok: true, msg: g.isActive ? 'Геозона выключена' : 'Геозона включена' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось переключить (нужен 2FA)') });
    }
  };

  const setObjects = async (g: IMtsGeofence, nextIds: string[]): Promise<void> => {
    setFeedback(null);
    try {
      await setObjectsMutation.mutateAsync({ id: g.id, skudObjectIds: nextIds });
      setFeedback({ ok: true, msg: 'Объекты обновлены' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось обновить объекты (нужен 2FA)') });
    }
  };

  const startEditGeometry = (g: IMtsGeofence): void => {
    setEditingGeometryId(g.id);
    setEditedRing(null);
    setFeedback({ ok: true, msg: 'Перетаскивайте вершины полигона. Кнопка «Сохранить геометрию» сохранит изменения.' });
  };

  const cancelEditGeometry = (): void => {
    setEditingGeometryId(null);
    setEditedRing(null);
  };

  const saveGeometry = async (g: IMtsGeofence): Promise<void> => {
    if (!editedRing || editedRing.length < 3) {
      setFeedback({ ok: false, msg: 'Полигон должен иметь минимум 3 точки' });
      return;
    }
    setFeedback(null);
    try {
      await updateMutation.mutateAsync({ id: g.id, input: { geometry: editedRing } });
      setEditingGeometryId(null);
      setEditedRing(null);
      setFeedback({ ok: true, msg: 'Геометрия обновлена' });
    } catch (e) {
      setFeedback({ ok: false, msg: errText(e, 'Не удалось сохранить геометрию (нужен 2FA)') });
    }
  };

  return (
    <section className={pageStyles.card}>
      <div className={pageStyles.toolbarRow}>
        <span className={pageStyles.hint}>Всего: {all.length}</span>
        <div className={pageStyles.actions}>
          <button
            className={drawing ? pageStyles.btn : pageStyles.btnSecondary}
            onClick={() => setDrawing(v => !v)}
            disabled={createMutation.isPending}
          >
            {drawing ? 'Отменить рисование' : '+ Нарисовать новую зону'}
          </button>
        </div>
      </div>

      <p className={pageStyles.hint}>
        Нарисуйте полигон на карте, сохраните, затем привяжите к сотрудникам или объектам FOT.
        Уведомления администратору приходят, если сотрудник вне геозоны во время своей смены.
      </p>

      {feedback && <p className={feedback.ok ? pageStyles.ok : pageStyles.err}>{feedback.msg}</p>}

      {pendingRing && (
        <div className={pageStyles.card} style={{ marginBottom: 8 }}>
          <p className={pageStyles.hint}>
            Полигон нарисован ({pendingRing.length} точек). Назовите и сохраните — потребует 2FA.
          </p>
          <div className={pageStyles.field}>
            <input
              className={pageStyles.input}
              type="text"
              placeholder="Название зоны"
              value={pendingName}
              onChange={e => setPendingName(e.target.value)}
            />
          </div>
          <div className={pageStyles.actions}>
            <button className={pageStyles.btn} onClick={savePending} disabled={createMutation.isPending}>
              Сохранить
            </button>
            <button className={pageStyles.btnSecondary} onClick={() => { setPendingRing(null); setPendingName(''); }}>
              Отбросить
            </button>
          </div>
        </div>
      )}

      <div className={styles.layout}>
        <div className={styles.list}>
          {geofencesQuery.isLoading && <p className={pageStyles.hint}>Загрузка…</p>}
          {geofencesQuery.isSuccess && all.length === 0 && !pendingRing && (
            <p className={pageStyles.hint}>Геозон пока нет. Нажмите «Нарисовать новую зону».</p>
          )}
          {all.map(g => {
            const isSel = g.id === selectedId;
            const isEditing = editingGeometryId === g.id;
            return (
              <div
                key={g.id}
                className={`${styles.geoCard} ${isSel ? styles.geoCardActive : ''} ${!g.isActive ? styles.inactive : ''}`}
                onClick={() => toggleCard(g)}
              >
                <div className={styles.geoCardHeader}>
                  <span className={styles.geoCardName}>
                    {isSel ? '▾ ' : '▸ '}{g.name}
                  </span>
                  <button
                    className={`${pageStyles.btnIcon} ${pageStyles.btnIconDanger}`}
                    onClick={(e) => { e.stopPropagation(); remove(g); }}
                    disabled={deleteMutation.isPending}
                    title="Удалить геозону"
                    aria-label="Удалить"
                  >
                    🗑
                  </button>
                </div>
                <div className={styles.geoMeta}>
                  <span>{g.geometry.length} точек</span>
                  <span>· сотрудников: {g.employeeIds.length}</span>
                  <span>· объектов: {g.skudObjectIds.length}</span>
                  <span>· {g.isActive ? 'активна' : 'отключена'}</span>
                </div>
                {isSel && (
                  <div className={styles.editor} onClick={e => e.stopPropagation()}>
                    <div className={styles.editorRow}>
                      <input
                        className={pageStyles.input}
                        type="text"
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                      />
                      <button
                        className={pageStyles.btnSm}
                        onClick={() => rename(g, renameDraft.trim())}
                        disabled={updateMutation.isPending || !renameDraft.trim() || renameDraft.trim() === g.name}
                      >
                        Сохранить имя
                      </button>
                    </div>
                    <div className={styles.editorRow}>
                      <label>
                        <input
                          type="checkbox"
                          checked={g.isActive}
                          onChange={() => toggleActive(g)}
                          disabled={updateMutation.isPending}
                        />
                        Активна
                      </label>
                    </div>
                    <div className={styles.editorRow}>
                      {!isEditing ? (
                        <button
                          className={pageStyles.btnSecondary}
                          onClick={() => startEditGeometry(g)}
                          disabled={updateMutation.isPending}
                        >
                          ✎ Редактировать геометрию
                        </button>
                      ) : (
                        <>
                          <button
                            className={pageStyles.btn}
                            onClick={() => saveGeometry(g)}
                            disabled={updateMutation.isPending || !editedRing || editedRing.length < 3}
                          >
                            Сохранить геометрию
                          </button>
                          <button
                            className={pageStyles.btnSecondary}
                            onClick={cancelEditGeometry}
                            disabled={updateMutation.isPending}
                          >
                            Отмена
                          </button>
                        </>
                      )}
                    </div>
                    <div>
                      <label className={pageStyles.label}>Привязка к объектам FOT</label>
                      <GeofenceMultiSelect
                        // Адаптер: маппим skud_objects в shape IMtsGeofence для переиспользования компонента.
                        options={(objectsQuery.data ?? []).map(o => ({
                          id: o.id,
                          name: o.name,
                          geometry: [],
                          isActive: true,
                          createdBy: null,
                          createdAt: '',
                          updatedAt: '',
                          employeeIds: [],
                          skudObjectIds: [],
                        }))}
                        value={g.skudObjectIds}
                        onChange={ids => setObjects(g, ids)}
                        disabled={setObjectsMutation.isPending}
                        placeholder="+ Выбрать объект"
                      />
                    </div>
                    {g.skudObjectIds.length > 0 && (
                      <div className={styles.geoMeta}>
                        Привязано к: {g.skudObjectIds.map(id => objectsById.get(id)?.name ?? id).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.mapWrap}>
          <MapContainer center={DEFAULT_CENTER} zoom={11} style={{ width: '100%', height: '100%' }} scrollWheelZoom>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
            <GeomanControls enabled={drawing} onPolygonCreated={handlePolygonCreated} />
            <FitBounds polygons={polygonsForFit} />
            {all.map(g => (
              <EditableGeofencePolygon
                key={`${g.id}-${editingGeometryId === g.id ? 'edit' : 'view'}`}
                g={g}
                isSelected={selectedId === g.id}
                isEditing={editingGeometryId === g.id}
                onSelect={() => toggleCard(g)}
                onGeometryChange={setEditedRing}
              />
            ))}
          </MapContainer>
        </div>
      </div>

      <p className={pageStyles.hint} style={{ marginTop: 8 }}>
        Сотрудники привязываются к геозонам во вкладке «Сотрудники» (колонка «Геозоны»).
      </p>
    </section>
  );
};
