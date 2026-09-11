import { lazy, useMemo, type FC } from 'react';
import { Wallet } from 'lucide-react';

import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const CompensationTermsPage = lazy(() => import('../salary/CompensationTermsPage').then(m => ({ default: m.CompensationTermsPage })));

/**
 * Раздел «Зарплата».
 *
 * Вкладка появляется по готовности этапа, а не заглушкой. Сейчас готов этап 1 —
 * условия оплаты: категория персонала и вид оплаты («по графику» / «по часам»).
 * Расчёт, выплаты, больничные, отпуска и удержания придут со своими этапами;
 * до этого их ключи доступа не заводятся (иначе контракт-тест каталога считает
 * их orphan, а роль получает право на несуществующий экран).
 */
export const SalaryHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'terms',
      label: 'Условия оплаты',
      accessPath: '/salary/terms',
      icon: Wallet,
      render: () => <CompensationTermsPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="terms" />;
};
