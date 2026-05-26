import { type FC, useMemo, useState, lazy, Suspense } from 'react';
import {
  useMtsEmployeesLinked,
  useMtsConnectionSettings,
  useMtsGeofences,
  useSetGeofenceAssignments,
  useAutoLinkMappings,
} from '../../hooks/useMtsData';
import { ApiError } from '../../api/client';
import { GeofenceMultiSelect } from './GeofenceMultiSelect';
import styles from './MtsPage.module.css';

const MtsMapModal = lazy(() => import('./MtsMapModal').then(m => ({ default: m.MtsMapModal })));

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

const PAGE_SIZE = 50;

export const LinkedTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [mapTarget, setMapTarget] = useState<{ employeeId: number; subscriberId: number; fullName: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const linkedQuery = useMtsEmployeesLinked({ search, page, pageSize: PAGE_SIZE }, configured);
  const geofencesQuery = useMtsGeofences(configured);
  const setAssignments = useSetGeofenceAssignments();
  const autoLinkMutation = useAutoLinkMappings();

  const total = linkedQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /**
   * Карта employeeId → массив id геозон, к которым он привязан.
   * Геозоны хранят assignment как (geofence → employeeIds[]), значит
   * для отображения «у сотрудника N» инвертируем структуру.
   */
  const geosByEmployee = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const g of geofencesQuery.data ?? []) {
      for (const eid of g.employeeIds) {
        const arr = m.get(eid) || [];
        arr.push(g.id);
        m.set(eid, arr);
      }
    }
    return m;
  }, [geofencesQuery.data]);

  /** Применить новый список геозон у сотрудника: пересобрать assignments каждой затронутой зоны. */
  const persistEmployeeGeofences = async (employeeId: number, nextIds: string[]): Promise<void> => {
    const currentIds = new Set(geosByEmployee.get(employeeId) ?? []);
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
        const wasMember = g.employeeIds.includes(employeeId);
        const shouldBeMember = nextSet.has(gid);
        if (wasMember === shouldBeMember) continue;
        const newMembers = shouldBeMember
          ? [...g.employeeIds, employeeId]
          : g.employeeIds.filter(e => e !== employeeId);
        await setAssignments.mutateAsync({ id: gid, employeeIds: newMembers });
      }
      setStatus({ ok: true, msg: 'Геозоны обновлены' });
    } catch (e) {
      setStatus({ ok: false, msg: errText(e, 'Ошибка обновления геозон (нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.tableHeader}>
        <h2 className={styles.cardTitle}>
          Сотрудники с MTS-привязкой {total > 0 ? `(${total})` : ''}
        </h2>
        <div className={styles.actions}>
          <input
            className={`${styles.input} ${styles.searchInput}`}
            type="search"
            placeholder="Поиск по ФИО…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
          <button
            className={styles.btnSecondary}
            disabled={autoLinkMutation.isPending}
            onClick={async () => {
              setStatus(null);
              try {
                const r = await autoLinkMutation.mutateAsync();
                setStatus({ ok: true, msg: `Авто-привязано: ${r.applied}` });
              } catch (e) {
                setStatus({ ok: false, msg: errText(e, 'Ошибка авто-привязки (нужен 2FA)') });
              }
            }}
          >
            Авто-привязка по ФИО (2FA)
          </button>
        </div>
      </div>

      <p className={styles.hint}>
        Назначайте геозоны прямо в строке — изменения сохраняются сразу (нужен 2FA при первой записи).
        Кнопка «Карта» — треки на OSM и индивидуальное рисование зоны для одного сотрудника.
      </p>

      {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}
      {linkedQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {linkedQuery.isError && <p className={styles.err}>Не удалось загрузить список</p>}
      {linkedQuery.isSuccess && total === 0 && (
        <p className={styles.hint}>
          Привязок пока нет. Перейдите во вкладку «Абоненты МТС» и назначьте каждому абоненту сотрудника FOT.
        </p>
      )}

      {linkedQuery.data && linkedQuery.data.data.length > 0 && (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Таб.№</th>
                  <th>Телефон МТС</th>
                  <th>Последний пинг</th>
                  <th>Геозоны</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {linkedQuery.data.data.map(row => (
                  <tr key={row.subscriberId}>
                    <td>{row.employeeFullName || row.displayName || `#${row.employeeId}`}</td>
                    <td>{row.employeeTabNumber || '—'}</td>
                    <td>{row.phone || '—'}</td>
                    <td>{row.lastRecordedAt ? new Date(row.lastRecordedAt).toLocaleString('ru-RU') : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {row.employeeId != null ? (
                        <GeofenceMultiSelect
                          value={geosByEmployee.get(row.employeeId) ?? []}
                          options={geofencesQuery.data ?? []}
                          onChange={ids => persistEmployeeGeofences(row.employeeId as number, ids)}
                          disabled={setAssignments.isPending || !configured}
                          placeholder="+ Выбрать"
                        />
                      ) : '—'}
                    </td>
                    <td>
                      <button
                        className={styles.btnSm}
                        disabled={!row.employeeId}
                        onClick={() => {
                          if (!row.employeeId) return;
                          setMapTarget({
                            employeeId: row.employeeId,
                            subscriberId: row.subscriberId,
                            fullName: row.employeeFullName || row.displayName || `#${row.employeeId}`,
                          });
                        }}
                        title="Карта: треки и индивидуальное рисование зон"
                      >
                        🗺 Карта
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                ← Назад
              </button>
              <span className={styles.paginationInfo}>
                Страница {page} из {totalPages} · всего {total}
              </span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                Вперёд →
              </button>
            </div>
          )}
        </>
      )}

      {mapTarget && (
        <Suspense fallback={<div />}>
          <MtsMapModal target={mapTarget} onClose={() => setMapTarget(null)} />
        </Suspense>
      )}
    </section>
  );
};
