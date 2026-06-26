import { lazy, useMemo, type FC } from 'react';
import { ClipboardCheck, MessageSquare, Plane } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const LeaveRequestsManagePage = lazy(() => import('../LeaveRequestsManagePage').then(m => ({ default: m.LeaveRequestsManagePage })));
const FeedbackReviewPage = lazy(() => import('../FeedbackReviewPage').then(m => ({ default: m.FeedbackReviewPage })));
const VacationsManagePage = lazy(() => import('../VacationsManagePage').then(m => ({ default: m.VacationsManagePage })));
// Вкладка «Повышение оклада» скрыта (SalaryRaiseReviewPage сохранён, маршрут /salary-raise-review активен).

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
      key: 'feedback',
      label: 'Обратная связь',
      accessPath: '/feedback-review',
      icon: MessageSquare,
      render: () => <FeedbackReviewPage />,
    },
    {
      // Доступ к вкладке «Отпуска» — только админ и отдел кадров (маркер /leave-vacations).
      key: 'vacations',
      label: 'Отпуска',
      accessPath: '/leave-vacations',
      icon: Plane,
      render: () => <VacationsManagePage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="requests" />;
};
