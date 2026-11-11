import { type FC, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTimesheetDepartmentAccess } from '../../hooks/useTimesheetDepartmentAccess';
import styles from './StaffDepartmentLink.module.css';

interface IStaffDepartmentLinkProps {
  departmentId: string | null;
  name: string | null;
  isFired: boolean;
}

// Клик по отделу не должен открывать карточку сотрудника (клик и колесо строки).
// Только stopPropagation: preventDefault сломал бы открытие в новой вкладке.
const stopRowHandlers = (e: SyntheticEvent) => e.stopPropagation();

/** Отдел в «Текущих сотрудниках»: ссылка на табель отдела, если он открыт пользователю. */
export const StaffDepartmentLink: FC<IStaffDepartmentLinkProps> = ({ departmentId, name, isFired }) => {
  const { canViewPage } = useAuth();
  const canOpenDepartment = useTimesheetDepartmentAccess();

  if (!name) return <>—</>;
  // У уволенных отдел «Уволенные» — табель такого отдела не нужен.
  if (!departmentId || isFired || !canViewPage('/timesheet') || !canOpenDepartment(departmentId)) {
    return <>{name}</>;
  }

  // mode=department явно: у табельщицы по умолчанию «назначенный» режим.
  const params = new URLSearchParams({ mode: 'department', dept: departmentId });
  return (
    <Link
      to={`/timesheet?${params.toString()}`}
      className={styles.link}
      onClick={stopRowHandlers}
      onAuxClick={stopRowHandlers}
      onMouseDown={stopRowHandlers}
    >
      {name}
    </Link>
  );
};
