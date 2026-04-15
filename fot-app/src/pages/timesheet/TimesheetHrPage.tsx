import { Suspense, lazy, type FC, useState } from 'react';
import { Tabs } from '../../components/ui/Tabs';
import { useAuth } from '../../contexts/AuthContext';
import { TimesheetReviewPage } from './TimesheetReviewPage';
import styles from './TimesheetHrPage.module.css';

const MassTimesheetExportPage = lazy(() => import('./MassTimesheetExportPage').then(module => ({
  default: module.MassTimesheetExportPage,
})));

const TABS = ['Экспорт', 'Проверка'];

export const TimesheetHrPage: FC = () => {
  const { hasPermission } = useAuth();
  const [active, setActive] = useState(0);
  const canAccessWorkflow = hasPermission('timesheet.workflow.review')
    || hasPermission('timesheet.workflow.monitor');

  if (!canAccessWorkflow) {
    return (
      <div className={styles.page}>
        <section className={styles.workspace}>
          <div className={styles.loadingState}>Для этой роли не включён доступ к сценарию проверки табелей.</div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.workspace}>
        <div className={styles.workspaceTabs}>
          <Tabs tabs={TABS} activeTab={active} onTabChange={setActive} />
        </div>

        <div className={styles.workspaceBody}>
          {active === 0 ? (
            <Suspense fallback={<div className={styles.loadingState}>Загрузка экспорта...</div>}>
              <MassTimesheetExportPage />
            </Suspense>
          ) : (
            <TimesheetReviewPage />
          )}
        </div>
      </section>
    </div>
  );
};
