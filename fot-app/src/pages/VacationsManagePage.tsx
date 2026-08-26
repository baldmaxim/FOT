import type { FC } from 'react';
import { HrAckRequestsPage } from './HrAckRequestsPage';

// Вкладка «Отпуска» (отдел кадров): общий алгоритм — в HrAckRequestsPage.
export const VacationsManagePage: FC = () => <HrAckRequestsPage variant="vacations" />;
