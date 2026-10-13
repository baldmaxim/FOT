import { lazy, useMemo, type FC } from 'react';
import { Wallet } from 'lucide-react';

import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const PaymentsTab = lazy(() => import('../salary/PaymentsTab').then(m => ({ default: m.PaymentsTab })));

/**
 * Раздел «Зарплата»: сейчас одна вкладка «Выплаты» (рабочий экран — «Условия оплаты»).
 *
 * Вкладки «Больничные», «Отпуска», «Удержания» убраны с экрана; их ключи доступа
 * (/salary/sick-leaves|vacations|deductions, миграция 275) сохранены для будущих этапов.
 */
export const SalaryHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'payments',
      label: 'Выплаты',
      // Условия оплаты живут внутри «Выплат»: роль только с /salary/terms тоже должна попасть сюда.
      accessPath: ['/salary/payments', '/salary/terms'],
      icon: Wallet,
      render: () => <PaymentsTab />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="payments" />;
};
