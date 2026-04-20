import { Suspense, type FC } from 'react';
import { SchedulesPage } from '../admin/SchedulesPage';

export const PayrollHubPage: FC = () => {
  return (
    <Suspense fallback={null}>
      <SchedulesPage />
    </Suspense>
  );
};
