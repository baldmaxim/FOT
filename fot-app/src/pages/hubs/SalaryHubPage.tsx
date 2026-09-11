import { lazy, useMemo, type FC } from 'react';
import { Wallet, HeartPulse, Palmtree, MinusCircle } from 'lucide-react';

import { HubShell, type IHubTab } from '../../components/hub/HubShell';
import { SalaryTabPlaceholder } from '../../components/salary/SalaryTabPlaceholder';

const PaymentsTab = lazy(() => import('../salary/PaymentsTab').then(m => ({ default: m.PaymentsTab })));

/**
 * Раздел «Зарплата»: Выплаты, Больничные, Отпуска, Удержания.
 *
 * Рабочий экран сейчас — «Выплаты → Условия оплаты». Остальные вкладки показывают,
 * что в них появится и на каком этапе. Каждая вкладка — свой ключ доступа, чтобы позже
 * раздать их разным ролям через админку без миграции и деплоя.
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
    {
      key: 'sick-leaves',
      label: 'Больничные',
      accessPath: '/salary/sick-leaves',
      icon: HeartPulse,
      render: () => (
        <SalaryTabPlaceholder
          title="Больничные"
          description="Листки нетрудоспособности: период, процент оплаты, дни за счёт работодателя и за счёт СФР, связь с заявлением сотрудника."
          stage="Этап 4 — после утверждения правил бухгалтерией"
        />
      ),
    },
    {
      key: 'vacations',
      label: 'Отпуска',
      accessPath: '/salary/vacations',
      icon: Palmtree,
      render: () => (
        <SalaryTabPlaceholder
          title="Отпуска"
          description="Отпуска и отпускные: средний заработок, срок выплаты, остатки дней отпуска по каждому сотруднику."
          stage="Этап 4 — после утверждения правил бухгалтерией"
        />
      ),
    },
    {
      key: 'deductions',
      label: 'Удержания',
      accessPath: '/salary/deductions',
      icon: MinusCircle,
      render: () => (
        <SalaryTabPlaceholder
          title="Удержания"
          description="К удержанию: депремирование, возмещение ущерба, удержания по ст. 137 ТК. Отдельно — возмещения сотруднику за спецодежду, инструмент и медосмотр."
          stage="Этап 4 — после согласования оснований с юристом и бухгалтерией"
        />
      ),
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="payments" />;
};
