import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { directReportsService, type IDirectReport } from '../../services/directReportsService';
import { useToast } from '../../contexts/ToastContext';
import { ApiError } from '../../api/client';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

interface IDirectReportsForEmployeeProps {
  managerEmployeeId: number;
  managerFullName: string;
  /** Все сотрудники, доступные для назначения подчинёнными. */
  allEmployees: Array<{ employee_id: number; full_name: string }>;
}

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    .replace(/ /g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

export const DirectReportsForEmployee: FC<IDirectReportsForEmployeeProps> = ({
  managerEmployeeId,
  managerFullName,
  allEmployees,
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | number | null>(null);

  const queryKey = ['admin-direct-reports', managerEmployeeId];
  const directReportsQuery = useQuery<IDirectReport[]>({
    queryKey,
    queryFn: () => directReportsService.list({ managerEmployeeId }),
    staleTime: 30_000,
  });

  const directReports = directReportsQuery.data || [];
  const assignedSubordinateIds = useMemo(
    () => new Set(directReports.map(r => r.subordinate_employee_id)),
    [directReports],
  );

  const candidates = useMemo(() => {
    const search = normalizeText(searchQuery);
    return allEmployees
      .filter(e => e.employee_id !== managerEmployeeId && !assignedSubordinateIds.has(e.employee_id))
      .filter(e => !search || normalizeText(e.full_name).includes(search))
      .slice(0, 30);
  }, [allEmployees, managerEmployeeId, assignedSubordinateIds, searchQuery]);

  const handleAssign = async (subordinateEmployeeId: number) => {
    setPendingId(subordinateEmployeeId);
    try {
      await directReportsService.assign({ managerEmployeeId, subordinateEmployeeId });
      toast.success('Подчинённый назначен');
      await queryClient.invalidateQueries({ queryKey });
      setSearchQuery('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('Этот сотрудник уже назначен другому руководителю');
      } else {
        toast.error(error instanceof Error ? error.message : 'Ошибка назначения');
      }
    } finally {
      setPendingId(null);
    }
  };

  const handleUnassign = async (id: string) => {
    setPendingId(id);
    try {
      await directReportsService.unassign(id);
      toast.success('Подчинённый снят');
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка снятия назначения');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className={styles.departmentAccessSection} style={{ marginTop: 16 }}>
      <div className={styles.departmentAccessHeader}>
        <div>
          <div className={styles.departmentAccessTitle}>Прямые подчинённые</div>
          <div className={styles.departmentAccessHint}>
            Отдельные сотрудники, которых руководитель {managerFullName} увидит в своём табеле
            (поверх назначенных отделов). Один подчинённый может быть прицеплен только к одному руководителю.
          </div>
        </div>
        <div className={styles.departmentAccessCount}>
          {directReports.length} назначено
        </div>
      </div>

      {directReportsQuery.isPending && (
        <div className={styles.loading}>Загрузка...</div>
      )}

      {directReports.length > 0 && (
        <div className={styles.departmentAccessTags}>
          {directReports.map(report => (
            <button
              key={report.id}
              type="button"
              className={styles.departmentAccessTag}
              disabled={pendingId === report.id}
              onClick={() => void handleUnassign(report.id)}
              title="Нажмите, чтобы снять назначение"
            >
              {report.subordinate?.full_name || `ID ${report.subordinate_employee_id}`}
              <span style={{ marginLeft: 6, opacity: 0.6 }}>×</span>
            </button>
          ))}
        </div>
      )}

      <input
        type="text"
        placeholder="Найти и добавить сотрудника..."
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        className={`${styles.nameInput} ${styles.departmentAccessSearch}`}
      />

      <div className={styles.departmentAccessList}>
        {candidates.length > 0 ? (
          candidates.map(candidate => (
            <button
              key={candidate.employee_id}
              type="button"
              className={styles.departmentAccessItem}
              disabled={pendingId === candidate.employee_id}
              onClick={() => void handleAssign(candidate.employee_id)}
            >
              <span className={styles.departmentAccessItemLabel}>
                {candidate.full_name}
              </span>
            </button>
          ))
        ) : (
          <div className={styles.departmentAccessEmpty}>
            {searchQuery.trim()
              ? 'По запросу не найдено свободных сотрудников'
              : 'Начните вводить ФИО, чтобы найти сотрудника'}
          </div>
        )}
      </div>
    </div>
  );
};
