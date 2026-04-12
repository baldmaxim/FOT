import { Suspense, lazy, type FC, useState } from 'react';
import { Tabs } from '../../components/ui/Tabs';
import { TimesheetReviewPage } from './TimesheetReviewPage';

const MassTimesheetExportPage = lazy(() => import('./MassTimesheetExportPage').then(module => ({
  default: module.MassTimesheetExportPage,
})));

const TABS = ['Проверка', 'Экспорт'];

export const TimesheetHrPage: FC = () => {
  const [active, setActive] = useState(0);

  return (
    <div>
      <Tabs tabs={TABS} activeTab={active} onTabChange={setActive} />
      {active === 0 ? (
        <TimesheetReviewPage />
      ) : (
        <Suspense fallback={<div className="tsr-loading">Загрузка экспорта...</div>}>
          <MassTimesheetExportPage />
        </Suspense>
      )}
    </div>
  );
};
