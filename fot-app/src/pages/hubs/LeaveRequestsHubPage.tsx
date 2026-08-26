import { lazy, useMemo, type FC } from 'react';
import { BrainCircuit, ClipboardCheck, MessageSquare, Plane, UserMinus } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const LeaveRequestsManagePage = lazy(() => import('../LeaveRequestsManagePage').then(m => ({ default: m.LeaveRequestsManagePage })));
const FeedbackReviewPage = lazy(() => import('../FeedbackReviewPage').then(m => ({ default: m.FeedbackReviewPage })));
const VacationsManagePage = lazy(() => import('../VacationsManagePage').then(m => ({ default: m.VacationsManagePage })));
const DismissalsManagePage = lazy(() => import('../DismissalsManagePage').then(m => ({ default: m.DismissalsManagePage })));
const TestingReviewPage = lazy(() => import('../TestingReviewPage').then(m => ({ default: m.TestingReviewPage })));
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
      // Доступ к вкладке «Отпуска» — только админ и отдел кадров (маркер /leave-vacations).
      key: 'vacations',
      label: 'Отпуска',
      accessPath: '/leave-vacations',
      icon: Plane,
      render: () => <VacationsManagePage />,
    },
    {
      // «Увольнения» — тот же алгоритм, что у «Отпусков»; отдельный маркер /leave-dismissals.
      key: 'dismissals',
      label: 'Увольнения',
      accessPath: '/leave-dismissals',
      icon: UserMinus,
      render: () => <DismissalsManagePage />,
    },
    {
      key: 'feedback',
      label: 'Обратная связь',
      accessPath: '/feedback-review',
      icon: MessageSquare,
      render: () => <FeedbackReviewPage />,
    },
    {
      key: 'testing',
      label: 'Тестирование',
      accessPath: '/testing-review',
      icon: BrainCircuit,
      render: () => <TestingReviewPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="requests" />;
};
