import { type ChangeEvent, type FC, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Save, Trash2, Upload } from 'lucide-react';
import { travelTimeService } from '../../services/travelTimeService';
import type { ITravelObject, ITravelObjectMap, ITravelObjectMapPoint } from '../../types';
import '../../styles/TravelSettings.css';

interface ITravelObjectMapSectionProps {
  object: ITravelObject;
  canEdit: boolean;
  busy?: boolean;
  accessPointsDirty?: boolean;
  accessPointLabels?: Map<string, string>;
  setError: (error: string) => void;
  reloadObjects: () => Promise<void>;
}

const sortPoints = (points: ITravelObjectMapPoint[]): ITravelObjectMapPoint[] => (
  [...points].sort((left, right) => left.access_point_name.localeCompare(right.access_point_name, 'ru'))
);

const pointsEqual = (left: ITravelObjectMapPoint[], right: ITravelObjectMapPoint[]): boolean => {
  const sortedLeft = sortPoints(left);
  const sortedRight = sortPoints(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((point, index) => {
    const other = sortedRight[index];
    return other
      && point.access_point_name === other.access_point_name
      && Math.abs(point.x_ratio - other.x_ratio) < 0.000001
      && Math.abs(point.y_ratio - other.y_ratio) < 0.000001;
  });
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

export const TravelObjectMapSection: FC<ITravelObjectMapSectionProps> = ({
  object,
  canEdit,
  busy = false,
  accessPointsDirty = false,
  accessPointLabels,
  setError,
  reloadObjects,
}) => {
  const [objectMap, setObjectMap] = useState<ITravelObjectMap | null>(null);
  const [draftPoints, setDraftPoints] = useState<ITravelObjectMapPoint[]>([]);
  const [selectedAccessPoint, setSelectedAccessPoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const failedMapUrlsRef = useRef<Set<string>>(new Set());

  const resolveSelectedAccessPoint = useCallback((points: ITravelObjectMapPoint[], current: string | null): string | null => {
    if (current && object.access_points.includes(current)) return current;

    const placedPoints = new Set(points.map(point => point.access_point_name));
    return object.access_points.find(accessPoint => !placedPoints.has(accessPoint))
      || object.access_points[0]
      || null;
  }, [object.access_points]);

  const loadMap = useCallback(async () => {
    if (!object.has_map) {
      setObjectMap(null);
      setDraftPoints([]);
      setSelectedAccessPoint(resolveSelectedAccessPoint([], null));
      setEditorOpen(false);
      return;
    }

    setLoading(true);
    try {
      const data = await travelTimeService.getObjectMap(object.id);
      setObjectMap(data);
      setDraftPoints(data.points);
      setSelectedAccessPoint(current => resolveSelectedAccessPoint(data.points, current));
    } catch (error) {
      setObjectMap(null);
      setDraftPoints([]);
      setSelectedAccessPoint(resolveSelectedAccessPoint([], null));
      setError(error instanceof Error ? error.message : 'Не удалось загрузить карту объекта');
    } finally {
      setLoading(false);
    }
  }, [object.has_map, object.id, resolveSelectedAccessPoint, setError]);

  useEffect(() => {
    void loadMap();
  }, [loadMap]);

  useEffect(() => {
    setSelectedAccessPoint(current => resolveSelectedAccessPoint(draftPoints, current));
  }, [draftPoints, resolveSelectedAccessPoint]);

  const pointByName = useMemo(() => {
    const map = new Map<string, ITravelObjectMapPoint>();
    for (const point of draftPoints) {
      map.set(point.access_point_name, point);
    }
    return map;
  }, [draftPoints]);

  const getAccessPointLabel = useCallback((accessPointName: string): string => (
    accessPointLabels?.get(accessPointName) || accessPointName
  ), [accessPointLabels]);

  const selectedPoint = selectedAccessPoint ? pointByName.get(selectedAccessPoint) || null : null;
  const selectedAccessPointLabel = selectedAccessPoint ? getAccessPointLabel(selectedAccessPoint) : null;
  const pointsChanged = useMemo(
    () => !pointsEqual(draftPoints, objectMap?.points || []),
    [draftPoints, objectMap?.points],
  );
  const disabled = !canEdit || busy || loading || uploading || saving || deleting;

  const persistMapAndRefresh = useCallback(async (nextMap: ITravelObjectMap | null) => {
    setObjectMap(nextMap);
    setDraftPoints(nextMap?.points || []);
    await reloadObjects();
  }, [reloadObjects]);

  const handleUpload = useCallback(async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Для карты объекта допустимы только изображения');
      return;
    }

    setUploading(true);
    setError('');
    try {
      const uploadData = await travelTimeService.getObjectMapUploadUrl(object.id, {
        file_name: file.name,
        content_type: file.type,
        file_size: file.size,
      });
      await travelTimeService.uploadObjectMapFile(uploadData.upload_url, file);
      const confirmedMap = await travelTimeService.confirmObjectMapUpload(object.id, {
        storage_path: uploadData.storage_path,
        file_name: file.name,
        content_type: file.type,
        file_size: file.size,
      });
      await persistMapAndRefresh(confirmedMap);
      setEditorOpen(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось загрузить карту объекта');
    } finally {
      setUploading(false);
    }
  }, [object.id, persistMapAndRefresh, setError]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await handleUpload(file);
  };

  const handleMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled || accessPointsDirty || !selectedAccessPoint || !stageRef.current) return;

    const rect = stageRef.current.getBoundingClientRect();
    const xRatio = clampRatio((event.clientX - rect.left) / rect.width);
    const yRatio = clampRatio((event.clientY - rect.top) / rect.height);

    setDraftPoints(prev => sortPoints([
      ...prev.filter(point => point.access_point_name !== selectedAccessPoint),
      {
        access_point_name: selectedAccessPoint,
        x_ratio: xRatio,
        y_ratio: yRatio,
      },
    ]));
  };

  const handleRemoveSelectedPoint = () => {
    if (!selectedAccessPoint || disabled || accessPointsDirty) return;
    setDraftPoints(prev => prev.filter(point => point.access_point_name !== selectedAccessPoint));
  };

  const handleSavePoints = async () => {
    if (!objectMap || disabled || accessPointsDirty || !pointsChanged) return;

    setSaving(true);
    setError('');
    try {
      const nextMap = await travelTimeService.saveObjectMapPoints(object.id, draftPoints);
      await persistMapAndRefresh(nextMap);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось сохранить маркеры карты');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMap = async () => {
    if (!objectMap || disabled) return;
    const approved = window.confirm(`Удалить карту объекта "${object.name}"?`);
    if (!approved) return;

    setDeleting(true);
    setError('');
    try {
      await travelTimeService.deleteObjectMap(object.id);
      await persistMapAndRefresh(null);
      setEditorOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось удалить карту объекта');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="travel-map-section">
      <div className="travel-config-toolbar">
        <div>
          <div className="travel-config-sidebar-title">Карта объекта</div>
          <div className="travel-config-hint">
            Один скриншот карты на объект. После загрузки отметьте на изображении точки доступа,
            чтобы потом открывать карту по клику в детализации событий.
          </div>
        </div>
        <div className="travel-map-toolbar">
          <button
            type="button"
            className="sigur-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canEdit || busy || uploading || deleting}
          >
            <Upload size={14} />
            {objectMap ? 'Заменить карту' : 'Загрузить карту'}
          </button>
          {objectMap && (
            <>
              <button
                type="button"
                className="sigur-btn"
                onClick={() => setEditorOpen(prev => !prev)}
                disabled={loading}
              >
                <MapPin size={14} />
                {editorOpen ? 'Скрыть разметку' : 'Редактировать точки'}
              </button>
              <button
                type="button"
                className="sigur-btn"
                onClick={handleDeleteMap}
                disabled={!canEdit || busy || uploading || deleting}
              >
                <Trash2 size={14} />
                Удалить карту
              </button>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={event => { void handleFileChange(event); }}
      />

      {!objectMap && !loading && (
        <div className="travel-map-empty">
          Карта для этого объекта ещё не загружена.
        </div>
      )}

      {loading && (
        <div className="travel-map-empty">Загрузка карты объекта...</div>
      )}

      {objectMap && (
        <>
          <div className="travel-map-meta">
            <span>Файл: {objectMap.file_name}</span>
            <span>{formatFileSize(objectMap.file_size)}</span>
            <span>Размечено: {draftPoints.length} из {object.access_points.length}</span>
          </div>

          <div className="travel-map-preview">
            <div className="travel-map-preview-stage">
              <img
                src={objectMap.image_url}
                alt={`Карта объекта ${object.name}`}
                className="travel-map-preview-image"
                onError={() => {
                  const url = objectMap.image_url;
                  if (failedMapUrlsRef.current.has(url)) return;
                  failedMapUrlsRef.current.add(url);
                  void loadMap();
                }}
              />
              {draftPoints.map(point => (
                <div
                  key={point.access_point_name}
                  className={`travel-map-preview-marker${selectedAccessPoint === point.access_point_name ? ' selected' : ''}`}
                  style={{ left: `${point.x_ratio * 100}%`, top: `${point.y_ratio * 100}%` }}
                  title={getAccessPointLabel(point.access_point_name)}
                />
              ))}
            </div>
          </div>

          {editorOpen && (
            <>
              {accessPointsDirty && (
                <div className="travel-map-warning">
                  Сначала сохраните изменения списка точек доступа объекта, чтобы разметка работала с актуальным набором.
                </div>
              )}

              <div className="travel-map-editor">
                <div className="travel-map-point-list">
                  {object.access_points.length === 0 ? (
                    <div className="travel-map-empty">
                      Для разметки сначала назначьте объекту хотя бы одну точку доступа.
                    </div>
                  ) : (
                    object.access_points.map(accessPoint => {
                      const placedPoint = pointByName.get(accessPoint);
                      const selected = selectedAccessPoint === accessPoint;
                      return (
                        <button
                          key={accessPoint}
                          type="button"
                          className={`travel-map-point-item${selected ? ' selected' : ''}${placedPoint ? ' placed' : ''}`}
                          onClick={() => setSelectedAccessPoint(accessPoint)}
                        >
                          <span className="travel-map-point-item-name">{getAccessPointLabel(accessPoint)}</span>
                          <span className="travel-map-point-item-status">
                            {placedPoint ? 'Размещена' : 'Не размещена'}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>

                <div className="travel-map-canvas-wrap">
                  <div className="travel-map-canvas-toolbar">
                    <div className="travel-config-hint">
                      {selectedAccessPointLabel
                        ? `Выбрана точка: ${selectedAccessPointLabel}. Кликните по изображению, чтобы поставить или переместить маркер.`
                        : 'Выберите точку доступа слева, затем кликните по изображению.'}
                    </div>
                    <div className="travel-map-canvas-actions">
                      <button
                        type="button"
                        className="sigur-btn"
                        onClick={handleRemoveSelectedPoint}
                        disabled={!selectedPoint || disabled || accessPointsDirty}
                      >
                        Убрать маркер
                      </button>
                      <button
                        type="button"
                        className="sigur-btn sigur-btn-primary"
                        onClick={handleSavePoints}
                        disabled={!canEdit || busy || saving || accessPointsDirty || !pointsChanged}
                      >
                        <Save size={14} />
                        Сохранить маркеры
                      </button>
                    </div>
                  </div>

                  <div className="travel-map-canvas-shell">
                    <div
                      ref={stageRef}
                      className={`travel-map-canvas${selectedAccessPoint && !accessPointsDirty && canEdit ? ' interactive' : ''}`}
                      onClick={handleMapClick}
                    >
                      <img
                        src={objectMap.image_url}
                        alt={`Разметка карты объекта ${object.name}`}
                        className="travel-map-canvas-image"
                        onError={() => {
                          const url = objectMap.image_url;
                          if (failedMapUrlsRef.current.has(url)) return;
                          failedMapUrlsRef.current.add(url);
                          void loadMap();
                        }}
                      />
                      {draftPoints.map(point => (
                        <button
                          key={point.access_point_name}
                          type="button"
                          className={`travel-map-marker${selectedAccessPoint === point.access_point_name ? ' selected' : ''}`}
                          style={{ left: `${point.x_ratio * 100}%`, top: `${point.y_ratio * 100}%` }}
                          onClick={event => {
                            event.stopPropagation();
                            setSelectedAccessPoint(point.access_point_name);
                          }}
                          title={getAccessPointLabel(point.access_point_name)}
                        >
                          <span>{getAccessPointLabel(point.access_point_name)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
};
