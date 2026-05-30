import { type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { ObjectAccessPopover } from './ObjectAccessPopover';
import styles from '../../pages/admin/Admin.module.css';

interface IProps {
  userId: string;
}

/**
 * Назначение «объектов входа» табельщице. Аналог UserCompanyAccessSection,
 * но для роли timekeeper: пишет в timekeeper_object_access (миграция 150).
 */
export const TimekeeperObjectAccessSection: FC<IProps> = ({ userId }) => {
  const toast = useToast();

  const objectsQuery = useQuery({
    queryKey: ['admin-skud-objects'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    staleTime: 5 * 60_000,
  });

  const assignedQuery = useQuery({
    queryKey: ['admin-timekeeper-objects', userId],
    queryFn: () => adminService.getUserTimekeeperObjects(userId),
    staleTime: 30_000,
  });

  const handleSave = async (objectIds: string[]) => {
    try {
      await adminService.updateUserTimekeeperObjects(userId, objectIds);
      toast.success('Объекты табельщицы обновлены');
      await assignedQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
      throw error;
    }
  };

  return (
    <div>
      <div className={styles.companyAccessLabel}>Объекты табельщицы</div>
      <div className={styles.companyAccessHint}>
        Табельщица видит табель сотрудников этих объектов входа: бригады/отделы, назначенные объекту, их начальники участков, а также сотрудники, назначенные объекту явно.
      </div>
      <ObjectAccessPopover
        objects={objectsQuery.data || []}
        value={assignedQuery.data?.object_ids || []}
        onSave={handleSave}
        loading={objectsQuery.isLoading || assignedQuery.isLoading}
        emptyLabel="Объекты не назначены — табельщица никого не видит"
      />
    </div>
  );
};
