import { lazy, useMemo, type FC } from 'react';
import { ClipboardCheck, DollarSign } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const LeaveRequestsManagePage = lazy(() => import('../LeaveRequestsManagePage').then(m => ({ default: m.LeaveRequestsManagePage })));
const SalaryRaiseReviewPage = lazy(() => import('../SalaryRaiseReviewPage').then(m => ({ default: m.SalaryRaiseReviewPage })));

export const LeaveRequestsHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'requests',
      label: 'Заявления',
      accessPath: '/leave-requests',
      icon: ClipboardCheck,
      render: () => <LeaveRequestsManagePage />,
    },
    {
      key: 'salary-raise',
      label: 'Повышение оклада',
      accessPath: '/salary-raise-review',
      icon: DollarSign,
      render: () => <SalaryRaiseReviewPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="requests" />;
};
