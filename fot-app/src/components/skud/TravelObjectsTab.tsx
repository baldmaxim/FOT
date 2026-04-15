import { type FC, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { travelTimeService } from '../../services/travelTimeService';
import type { AccessPointOption, ITravelObject } from '../../types';
import '../../styles/TravelSettings.css';

interface ITravelObjectsTabProps {
  canEdit: boolean;
  selectedConnection: 'internal' | 'external';
  setError: (error: string) => void;
}

const normalizePoint = (value: string): string => value.trim();
const arraysEqual = (left: string[], right: string[]): boolean => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

export const TravelObjectsTab: FC<ITravelObjectsTabProps> = ({ canEdit, selectedConnection, setError }) => {
  const [objects, setObjects] = useState<ITravelObject[]>([]);
  const [accessPoints, setAccessPoints] = useState<AccessPointOption[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftAccessPoints, setDraftAccessPoints] = useState<string[]>([]);
  const [newObjectName, setNewObjectName] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedObjects, loadedAccessPoints] = await Promise.all([
        travelTimeService.getObjects(),
        skudService.getAccessPointOptions(selectedConnection),
      ]);
      setObjects(loadedObjects);
      setAccessPoints(
        loadedAccessPoints
          .map(point => ({ ...point, name: normalizePoint(point.name) }))
          .filter(point => !!point.name),
      );
      setSelectedObjectId(current => current && loadedObjects.some(object => object.id === current)
        ? current
        : loadedObjects[0]?.id || null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка загрузки объектов');
    } finally {
      setLoading(false);
    }
  }, [selectedConnection, setError]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedObject = useMemo(
    () => objects.find(object => object.id === selectedObjectId) || null,
    [objects, selectedObjectId],
  );

  useEffect(() => {
    if (!selectedObject) {
      setDraftName('');
      setDraftAccessPoints([]);
      return;
    }
    setDraftName(selectedObject.name);
    setDraftAccessPoints(selectedObject.access_points);
  }, [selectedObject]);

  const ownershipMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const object of objects) {
      for (const point of object.access_points) {
        const normalizedPoint = normalizePoint(point);
        if (!normalizedPoint) continue;
        map.set(normalizedPoint, object.id);
      }
    }
    return map;
  }, [objects]);

  const accessPointOptionsByName = useMemo(() => {
    const map = new Map<string, AccessPointOption>();
    for (const point of accessPoints) {
      if (!point.name || map.has(point.name)) continue;
      map.set(point.name, point);
    }
    return map;
  }, [accessPoints]);

  const availableAccessPoints = useMemo(() => {
    if (!selectedObject) return [];

    const pointNames = [...new Set([
      ...accessPoints.map(point => normalizePoint(point.name)),
      ...draftAccessPoints.map(normalizePoint),
    ].filter(Boolean))];

    return pointNames
      .filter(point => {
        const owner = ownershipMap.get(point);
        return !owner || owner === selectedObject.id;
      })
      .map(point => accessPointOptionsByName.get(point) || { name: point, id: null });
  }, [accessPointOptionsByName, accessPoints, draftAccessPoints, ownershipMap, selectedObject]);

  const unassignedAccessPointsCount = useMemo(
    () => accessPoints.filter(point => !ownershipMap.has(point.name)).length,
    [accessPoints, ownershipMap],
  );

  const filteredAccessPoints = useMemo(() => {
    if (!search.trim()) return availableAccessPoints;
    const query = search.trim().toLowerCase();
    return availableAccessPoints.filter(point => {
      const label = point.id == null ? point.name : `${point.name} (${point.id})`;
      return label.toLowerCase().includes(query);
    });
  }, [availableAccessPoints, search]);

  const selectedSet = useMemo(() => new Set(draftAccessPoints), [draftAccessPoints]);
  const selectedObjectNameChanged = useMemo(
    () => !!selectedObject && draftName.trim() !== selectedObject.name,
    [draftName, selectedObject],
  );
  const selectedObjectAccessPointsChanged = useMemo(
    () => !!selectedObject && !arraysEqual(draftAccessPoints, selectedObject.access_points),
    [draftAccessPoints, selectedObject],
  );

  const togglePoint = (accessPoint: string) => {
    setDraftAccessPoints(prev => (
      prev.includes(accessPoint)
        ? prev.filter(item => item !== accessPoint)
        : [...prev, accessPoint].sort((left, right) => left.localeCompare(right, 'ru'))
    ));
  };

  const handleCreateObject = async () => {
    if (!newObjectName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const created = await travelTimeService.createObject(newObjectName.trim());
      setObjects(prev => [...prev, created].sort((left, right) => left.name.localeCompare(right.name, 'ru')));
      setSelectedObjectId(created.id);
      setNewObjectName('');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка создания объекта');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateObjectKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    if (!canEdit || saving || !newObjectName.trim()) return;

    event.preventDefault();
    void handleCreateObject();
  };

  const handleSaveObject = async () => {
    if (!selectedObject || !selectedObjectAccessPointsChanged) return;
    setSaving(true);
    setError('');
    try {
      await travelTimeService.updateObject(selectedObject.id, {
        name: selectedObject.name,
        access_points: draftAccessPoints,
      });
      const refreshedObjects = await travelTimeService.getObjects();
      setObjects(refreshedObjects);
      setSelectedObjectId(selectedObject.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка сохранения объекта');
    } finally {
      setSaving(false);
    }
  };

  const handleRenameObject = async () => {
    if (!selectedObject || !draftName.trim() || !selectedObjectNameChanged) return;
    setSaving(true);
    setError('');
    try {
      await travelTimeService.updateObject(selectedObject.id, {
        name: draftName.trim(),
        access_points: selectedObject.access_points,
      });
      const refreshedObjects = await travelTimeService.getObjects();
      setObjects(refreshedObjects);
      setSelectedObjectId(selectedObject.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка переименования объекта');
    } finally {
      setSaving(false);
    }
  };

  const handleRenameObjectKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    if (!canEdit || saving || !selectedObjectNameChanged || !draftName.trim()) return;

    event.preventDefault();
    void handleRenameObject();
  };

  const handleDeleteObject = async () => {
    if (!selectedObject) return;
    const approved = window.confirm(`Удалить объект "${selectedObject.name}"?`);
    if (!approved) return;

    setSaving(true);
    setError('');
    try {
      await travelTimeService.deleteObject(selectedObject.id);
      const nextObjects = objects.filter(object => object.id !== selectedObject.id);
      setObjects(nextObjects);
      setSelectedObjectId(nextObjects[0]?.id || null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка удаления объекта');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sigur-section">
      <div className="travel-config-toolbar">
        <div>
          <h3 className="sigur-section-title">Объекты и точки доступа</h3>
          <div className="travel-config-hint">
            В списке показываются нераспределённые точки доступа. Для выбранного объекта также видны уже привязанные к нему точки.
          </div>
        </div>
        <button className="sigur-btn" onClick={() => void loadData()} disabled={loading || saving}>
          Обновить
        </button>
      </div>

      <div className="travel-config-create">
        <input
          type="text"
          className="travel-config-input"
          placeholder="Новый объект"
          value={newObjectName}
          onChange={event => setNewObjectName(event.target.value)}
          onKeyDown={handleCreateObjectKeyDown}
          disabled={!canEdit || saving}
        />
        <button className="sigur-btn sigur-btn-primary" onClick={handleCreateObject} disabled={!canEdit || saving || !newObjectName.trim()}>
          <Plus size={14} />
          Добавить объект
        </button>
      </div>
      <div className="travel-config-hint" style={{ marginTop: '-0.25rem', marginBottom: '0.75rem' }}>
        {!canEdit
          ? 'Для создания объектов нужны права на редактирование страницы настроек СКУД.'
          : !newObjectName.trim()
            ? 'Введите название объекта, и кнопка станет активной.'
            : 'Нажмите "Добавить объект" или Enter.'}
      </div>

      {loading ? (
        <div className="travel-config-empty">Загрузка объектов...</div>
      ) : (
        <div className="travel-config-layout">
          <div className="travel-config-sidebar">
            <div className="travel-config-sidebar-title">Объекты</div>
            <div className="travel-config-list">
              {objects.map(object => (
                <button
                  key={object.id}
                  className={`travel-config-list-item ${selectedObjectId === object.id ? 'active' : ''}`}
                  onClick={() => setSelectedObjectId(object.id)}
                >
                  <span>{object.name}</span>
                  <span className="travel-config-count">{object.access_points.length}</span>
                </button>
              ))}
              {objects.length === 0 && (
                <div className="travel-config-empty">Объекты ещё не созданы</div>
              )}
            </div>
          </div>

          <div className="travel-config-main">
            {!selectedObject ? (
              <div className="travel-config-empty">Выберите объект слева или создайте новый</div>
            ) : (
              <>
                <div className="travel-config-hint" style={{ marginBottom: '0.75rem' }}>
                  Переименование объекта выполняется отдельно. Точки доступа сохраняются отдельной кнопкой ниже.
                </div>
                <div className="travel-config-actions">
                  <input
                    type="text"
                    className="travel-config-input"
                    value={draftName}
                    onChange={event => setDraftName(event.target.value)}
                    onKeyDown={handleRenameObjectKeyDown}
                    disabled={!canEdit || saving}
                  />
                  <button
                    className="sigur-btn"
                    onClick={handleRenameObject}
                    disabled={!canEdit || saving || !draftName.trim() || !selectedObjectNameChanged}
                  >
                    <Pencil size={14} />
                    Переименовать
                  </button>
                  <button
                    className="sigur-btn sigur-btn-primary"
                    onClick={handleSaveObject}
                    disabled={!canEdit || saving || !selectedObjectAccessPointsChanged}
                  >
                    <Save size={14} />
                    Сохранить точки
                  </button>
                  <button className="sigur-btn" onClick={handleDeleteObject} disabled={!canEdit || saving}>
                    <Trash2 size={14} />
                    Удалить
                  </button>
                </div>

                <div className="travel-config-search-row">
                  <input
                    type="text"
                    className="travel-config-input"
                    placeholder="Поиск точки доступа"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                  />
                  <div className="travel-config-hint">
                    Нераспределённых: {unassignedAccessPointsCount} · Выбрано: {draftAccessPoints.length}
                  </div>
                </div>

                <div className="travel-config-points">
                  {filteredAccessPoints.map(point => {
                    const label = point.id == null ? point.name : `${point.name} (${point.id})`;
                    const selected = selectedSet.has(point.name);
                    return (
                      <label key={point.name} className={`travel-config-point ${selected ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => togglePoint(point.name)}
                          disabled={!canEdit || saving}
                        />
                        <span className="travel-config-point-name">{label}</span>
                      </label>
                    );
                  })}
                  {filteredAccessPoints.length === 0 && (
                    <div className="travel-config-empty">
                      {search.trim()
                        ? 'Нет точек доступа по текущему фильтру'
                        : 'Нет нераспределённых точек доступа'}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
