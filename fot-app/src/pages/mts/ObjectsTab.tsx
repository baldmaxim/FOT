import { type FC, useMemo, useState } from 'react';
import {
  useMtsSkudObjectsLite,
  useMtsGeofences,
  useMtsConnectionSettings,
  useSetGeofenceObjects,
} from '../../hooks/useMtsData';
import type { IMtsGeofence } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { GeofenceMultiSelect } from './GeofenceMultiSelect';
import styles from './MtsPage.module.css';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

export const ObjectsTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const objectsQuery = useMtsSkudObjectsLite(configured);
  const geofencesQuery = useMtsGeofences(configured);
  const setObjectsMutation = useSetGeofenceObjects();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  /** Map: skud_object_id → array of geofence ids. */
  const geosByObject = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of geofencesQuery.data ?? []) {
      for (const oid of g.skudObjectIds) {
        const arr = m.get(oid) || [];
        arr.push(g.id);
        m.set(oid, arr);
      }
    }
    return m;
  }, [geofencesQuery.data]);

  const filteredObjects = useMemo(() => {
    const all = objectsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(o => o.name.toLowerCase().includes(q));
  }, [objectsQuery.data, search]);

  /**
   * Применяет новый набор геозон для объекта: для каждой затронутой геозоны
   * пересобирает её skud_object_ids через setGeofenceObjects.
   */
  const persistObjectGeofences = async (objectId: string, nextIds: string[]): Promise<void> => {
    const currentIds = new Set(geosByObject.get(objectId) ?? []);
    const nextSet = new Set(nextIds);
    const toAdd = [...nextSet].filter(id => !currentIds.has(id));
    const toRemove = [...currentIds].filter(id => !nextSet.has(id));
    const affected = [...toAdd, ...toRemove];
    if (affected.length === 0) return;

    setStatus(null);
    try {
      for (const gid of affected) {
        const g = (geofencesQuery.data ?? []).find(x => x.id === gid);
        if (!g) continue;
        const wasMember = g.skudObjectIds.includes(objectId);
        const shouldBeMember = nextSet.has(gid);
        if (wasMember === shouldBeMember) continue;
        const newMembers = shouldBeMember
          ? [...g.skudObjectIds, objectId]
          : g.skudObjectIds.filter(o => o !== objectId);
        await setObjectsMutation.mutateAsync({ id: gid, skudObjectIds: newMembers });
      }
      setStatus({ ok: true, msg: 'Привязки обновлены' });
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка (нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.tableHeader}>
        <h2 className={styles.cardTitle}>
          Объекты FOT {objectsQuery.data ? `(${filteredObjects.length}/${objectsQuery.data.length})` : ''}
        </h2>
        <div className={styles.actions}>
          <input
            className={`${styles.input} ${styles.searchInput}`}
            type="search"
            placeholder="Поиск по названию объекта…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <p className={styles.hint}>
        К каждому объекту FOT (группе точек доступа) можно прикрепить одну или несколько геозон.
        Геозоны создаются и рисуются во вкладке «Геозоны».
      </p>

      {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}
      {objectsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {objectsQuery.isError && <p className={styles.err}>Не удалось загрузить объекты</p>}
      {objectsQuery.isSuccess && filteredObjects.length === 0 && (
        <p className={styles.hint}>Объектов нет.</p>
      )}

      {filteredObjects.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Объект FOT</th>
                <th>Привязано геозон</th>
                <th>Геозоны</th>
              </tr>
            </thead>
            <tbody>
              {filteredObjects.map(o => {
                const objectGeoIds = geosByObject.get(o.id) ?? [];
                return (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td>{objectGeoIds.length}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      <GeofenceMultiSelect
                        value={objectGeoIds}
                        options={(geofencesQuery.data ?? []) as IMtsGeofence[]}
                        onChange={ids => persistObjectGeofences(o.id, ids)}
                        disabled={setObjectsMutation.isPending}
                        placeholder="+ Привязать геозону"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
