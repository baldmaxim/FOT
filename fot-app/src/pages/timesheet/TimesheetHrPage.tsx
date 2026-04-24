import { Suspense, lazy, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import styles from './TimesheetHrPage.module.css';

const MassTimesheetExportPage = lazy(() => import('./MassTimesheetExportPage').then(module => ({
  default: module.MassTimesheetExportPage,
})));

export const TimesheetHrPage: FC = () => {
  const { hasPermission } = useAuth();
  const canAccessExport = hasPermission('timesheet.workflow.review')
    || hasPermission('timesheet.workflow.monitor');

  if (!canAccessExport) {
    return (
      <div className={styles.page}>
        <section className={styles.workspace}>
          <div className={styles.loadingState}>Для этой роли не включён доступ к экспорту табелей.</div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.workspace}>
        <div className={styles.workspaceBody}>
          <Suspense fallback={<div className={styles.loadingState}>Загрузка экспорта...</div>}>
            <MassTimesheetExportPage />
          </Suspense>
        </div>
      </section>
    </div>
  );
};
