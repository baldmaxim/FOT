import { lazy, useMemo, type FC } from 'react';
import { FileText, Calendar } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const PayslipManagePage = lazy(() => import('../super-admin/PayslipManagePage').then(m => ({ default: m.PayslipManagePage })));
const SchedulesPage = lazy(() => import('../admin/SchedulesPage').then(m => ({ default: m.SchedulesPage })));

export const PayrollHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'payslips',
      label: 'Расчётные листки',
      accessPath: '/admin/payslips',
      icon: FileText,
      render: () => <PayslipManagePage />,
    },
    {
      key: 'schedules',
      label: 'Графики работы',
      accessPath: '/admin/schedules',
      icon: Calendar,
      render: () => <SchedulesPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="payslips" />;
};
