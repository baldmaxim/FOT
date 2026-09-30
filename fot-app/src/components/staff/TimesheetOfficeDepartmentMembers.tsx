import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import styles from './StaffTimesheetOfficeModal.module.css';

interface ITimesheetOfficeDepartmentMembersProps {
  departmentId: string;
  busy: boolean;
  onAssign: (employeeId: number) => void;
  onReturn: (employeeId: number) => void;
}

/**
 * Сотрудники выбранного отдела в окне «Режим табелирования» (миграция 291): прямые работающие,
 * объект табелирования на сейчас. «Офис» — личный «Офис», «Вернуть» — снять его (объект по
 * часам сразу). У отдела с «Офисом» кнопок нет: вернуть можно, только сняв «Офис» с отдела.
 */
export const TimesheetOfficeDepartmentMembers: FC<ITimesheetOfficeDepartmentMembersProps> = ({
  departmentId,
  busy,
  onAssign,
  onReturn,
}) => {
  // Префикс ключа общий с состоянием окна: сброс после записи перечитывает и список.
  const membersQuery = useQuery({
    queryKey: ['admin-timesheet-office', 'department', departmentId],
    queryFn: () => adminService.getTimesheetOfficeDepartmentMembers(departmentId),
    staleTime: 0,
  });
  const data = membersQuery.data;

  return (
    <section className={styles.assigned} aria-labelledby="timesheet-office-members">
      <h4 id="timesheet-office-members" className={styles.sectionTitle}>
        Сотрудники отдела
        {data && <span className={styles.muted}> · {data.employees.length}</span>}
      </h4>
      {membersQuery.isLoading && <div className={styles.muted}>Загрузка…</div>}
      {membersQuery.isError && !data && (
        <div className={styles.stateRow}>
          <span className={styles.muted}>Не удалось загрузить</span>
          <button type="button" className={styles.rowButton} onClick={() => void membersQuery.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {data?.office && <div className={styles.banner}>«Офис» назначен всему отделу</div>}
      {data && data.employees.length === 0 && <div className={styles.muted}>В отделе нет сотрудников</div>}

      {data && data.employees.length > 0 && (
        <ul className={styles.list}>
          {data.employees.map(member => (
            <li key={member.id} className={styles.memberRow}>
              <span className={styles.memberName}>{member.full_name}</span>
              <span className={styles.memberObject}>{member.label ?? '—'}</span>
              {!data.office && (
                <button
                  type="button"
                  className={styles.rowButton}
                  onClick={() => (member.personal_office ? onReturn(member.id) : onAssign(member.id))}
                  disabled={busy}
                  aria-label={`${member.personal_office ? 'Вернуть' : 'Офис'}: ${member.full_name}`}
                >
                  {member.personal_office ? 'Вернуть' : 'Офис'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
