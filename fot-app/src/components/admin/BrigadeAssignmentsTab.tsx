import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStructureTree } from '../../hooks/useStructure';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import { SearchInput } from '../ui/SearchInput';
import { adminService } from '../../services/adminService';
import styles from './BrigadeAssignmentsTab.module.css';

export const BrigadeAssignmentsTab: FC = () => {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const structureQuery = useStructureTree();

  const brigades = useMemo(
    () => getTreeFlatDepartments(structureQuery.data?.departments ?? [])
      .filter(d => d.kind === 'brigade'),
    [structureQuery.data],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return brigades;
    return brigades.filter(b => b.name.toLowerCase().includes(q));
  }, [brigades, search]);

  const assignedQuery = useQuery({
    queryKey: ['brigade-assigned-employees', selectedId],
    queryFn: () => adminService.getDepartmentAssignedEmployees(selectedId as string),
    enabled: !!selectedId,
  });

  const selectedBrigade = brigades.find(b => b.id === selectedId) ?? null;

  return (
    <div className={styles.wrap}>
      <aside className={styles.sidebar}>
        <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск бригады..." />
        <div className={styles.list}>
          {structureQuery.isPending ? (
            <div className={styles.muted}>Загрузка…</div>
          ) : filtered.length === 0 ? (
            <div className={styles.muted}>Бригады не найдены</div>
          ) : (
            filtered.map(b => (
              <button
                key={b.id}
                type="button"
                className={`${styles.item} ${selectedId === b.id ? styles.itemActive : ''}`}
                onClick={() => setSelectedId(b.id)}
              >
                {b.name}
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={styles.detail}>
        {!selectedId ? (
          <div className={styles.placeholder}>Выберите бригаду</div>
        ) : assignedQuery.isPending ? (
          <div className={styles.placeholder}>Загрузка…</div>
        ) : assignedQuery.isError ? (
          <div className={styles.placeholder}>Не удалось загрузить</div>
        ) : (assignedQuery.data?.length ?? 0) === 0 ? (
          <div className={styles.placeholder}>Нет назначенных сотрудников</div>
        ) : (
          <>
            <h3 className={styles.title}>
              {selectedBrigade?.name}
              <span className={styles.count}>{assignedQuery.data?.length}</span>
            </h3>
            <div className={styles.employees}>
              {assignedQuery.data?.map(emp => (
                <div key={emp.employee_id} className={styles.empRow}>
                  <div className={styles.empMain}>
                    <span className={styles.empName}>{emp.full_name}</span>
                    <span className={styles.empPos}>{emp.position_name ?? '—'}</span>
                  </div>
                  <div className={styles.empBadges}>
                    {emp.access_level === 'view' && (
                      <span className={styles.badge}>Только просмотр</span>
                    )}
                    {emp.employment_status !== 'active' && (
                      <span className={`${styles.badge} ${styles.badgeDanger}`}>Уволен</span>
                    )}
                    {emp.excluded_from_timesheet && (
                      <span className={`${styles.badge} ${styles.badgeWarn}`}>Не в табеле</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
};
