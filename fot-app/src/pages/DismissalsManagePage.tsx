import type { FC } from 'react';
import { HrAckRequestsPage } from './HrAckRequestsPage';

// Вкладка «Увольнения» (отдел кадров): тот же алгоритм, что у «Отпусков»,
// выборка строго request_type = 'dismissal', включая рабочих; маркер /leave-dismissals.
export const DismissalsManagePage: FC = () => <HrAckRequestsPage variant="dismissals" />;
