import { type FC, useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { travelTimeService } from '../../services/travelTimeService';
import type { ITravelObject, ITravelRoute } from '../../types';
import '../../styles/TravelSettings.css';

interface ITravelRoutesTabProps {
  canEdit: boolean;
  setError: (error: string) => void;
}

export const TravelRoutesTab: FC<ITravelRoutesTabProps> = ({ canEdit, setError }) => {
  const [objects, setObjects] = useState<ITravelObject[]>([]);
  const [routes, setRoutes] = useState<ITravelRoute[]>([]);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [fromObjectId, setFromObjectId] = useState('');
  const [toObjectId, setToObjectId] = useState('');
  const [travelMinutes, setTravelMinutes] = useState('40');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [loadedObjects, loadedRoutes] = await Promise.all([
        travelTimeService.getObjects(),
        travelTimeService.getRoutes(),
      ]);
      setObjects(loadedObjects);
      setRoutes(loadedRoutes);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка загрузки маршрутов');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const sortedObjects = useMemo(
    () => [...objects].sort((left, right) => left.name.localeCompare(right.name, 'ru')),
    [objects],
  );

  const resetForm = () => {
    setEditingRouteId(null);
    setFromObjectId(sortedObjects[0]?.id || '');
    setToObjectId(sortedObjects[1]?.id || sortedObjects[0]?.id || '');
    setTravelMinutes('40');
  };

  useEffect(() => {
    if (!editingRouteId && sortedObjects.length > 0) {
      setFromObjectId(prev => prev || sortedObjects[0].id);
      setToObjectId(prev => prev || sortedObjects[1]?.id || sortedObjects[0].id);
    }
  }, [editingRouteId, sortedObjects]);

  const handleSubmit = async () => {
    const minutes = Number(travelMinutes);
    if (!fromObjectId || !toObjectId || fromObjectId === toObjectId || !Number.isFinite(minutes) || minutes <= 0) {
      setError('Проверьте объекты и норматив времени');
      return;
    }

    setSaving(true);
    setError('');
    try {
      if (editingRouteId) {
        const updated = await travelTimeService.updateRoute(editingRouteId, {
          from_object_id: fromObjectId,
          to_object_id: toObjectId,
          travel_minutes: minutes,
        });
        setRoutes(prev => prev.map(route => route.id === updated.id ? updated : route));
      } else {
        const created = await travelTimeService.createRoute({
          from_object_id: fromObjectId,
          to_object_id: toObjectId,
          travel_minutes: minutes,
        });
        setRoutes(prev => [...prev, created]);
      }
      resetForm();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка сохранения маршрута');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (route: ITravelRoute) => {
    setEditingRouteId(route.id);
    setFromObjectId(route.from_object_id);
    setToObjectId(route.to_object_id);
    setTravelMinutes(String(route.travel_minutes));
  };

  const handleDelete = async (route: ITravelRoute) => {
    const approved = window.confirm(`Удалить маршрут "${route.from_object_name} -> ${route.to_object_name}"?`);
    if (!approved) return;
    setSaving(true);
    setError('');
    try {
      await travelTimeService.deleteRoute(route.id);
      setRoutes(prev => prev.filter(item => item.id !== route.id));
      if (editingRouteId === route.id) resetForm();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Ошибка удаления маршрута');
    } finally {
      setSaving(false);
    }
  };

  const sortedRoutes = useMemo(
    () => [...routes].sort((left, right) => {
      const leftName = `${left.from_object_name || ''}${left.to_object_name || ''}`;
      const rightName = `${right.from_object_name || ''}${right.to_object_name || ''}`;
      return leftName.localeCompare(rightName, 'ru');
    }),
    [routes],
  );

  return (
    <div className="sigur-section">
      <div className="travel-config-toolbar">
        <div>
          <h3 className="sigur-section-title">Маршруты между объектами</h3>
          <div className="travel-config-hint">
            Для расчёта используется лимит 1.5 x T. В табель добавляется только засчитываемая часть дороги.
          </div>
        </div>
        <button className="sigur-btn" onClick={() => void loadData()} disabled={loading || saving}>
          Обновить
        </button>
      </div>

      {loading ? (
        <div className="travel-config-empty">Загрузка маршрутов...</div>
      ) : (
        <>
          <div className="travel-route-form">
            <select value={fromObjectId} onChange={event => setFromObjectId(event.target.value)} disabled={!canEdit || saving}>
              <option value="">Откуда</option>
              {sortedObjects.map(object => (
                <option key={object.id} value={object.id}>{object.name}</option>
              ))}
            </select>
            <select value={toObjectId} onChange={event => setToObjectId(event.target.value)} disabled={!canEdit || saving}>
              <option value="">Куда</option>
              {sortedObjects.map(object => (
                <option key={object.id} value={object.id}>{object.name}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={1440}
              value={travelMinutes}
              onChange={event => setTravelMinutes(event.target.value)}
              disabled={!canEdit || saving}
              placeholder="Минут"
            />
            <button className="sigur-btn sigur-btn-primary" onClick={handleSubmit} disabled={!canEdit || saving}>
              {editingRouteId ? <><Save size={14} /> Сохранить</> : <><Plus size={14} /> Добавить</>}
            </button>
            {editingRouteId && (
              <button className="sigur-btn" onClick={resetForm} disabled={saving}>
                Сбросить
              </button>
            )}
          </div>

          <div className="travel-config-table-wrap">
            <table className="travel-config-table">
              <thead>
                <tr>
                  <th>Маршрут</th>
                  <th>T</th>
                  <th>1.5 x T</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {sortedRoutes.map(route => (
                  <tr key={route.id}>
                    <td>{route.from_object_name || '—'} {'->'} {route.to_object_name || '—'}</td>
                    <td>{route.travel_minutes} мин</td>
                    <td>{route.max_credit_minutes} мин</td>
                    <td className="travel-config-table-actions">
                      <button className="sigur-btn" onClick={() => handleEdit(route)} disabled={!canEdit || saving}>
                        <Save size={14} />
                        Изменить
                      </button>
                      <button className="sigur-btn" onClick={() => void handleDelete(route)} disabled={!canEdit || saving}>
                        <Trash2 size={14} />
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
                {sortedRoutes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="travel-config-empty">Маршруты ещё не созданы</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
