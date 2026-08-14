import { lazy, useMemo, type FC } from 'react';
import { BarChart3, Building2 } from 'lucide-react';

import { HubShell, type IHubTab } from '../../components/hub/HubShell';

/**
 * «Аналитика» стала хабом с двумя вкладками. Существующая страница дисциплины
 * не тронута — она целиком становится содержимым первой вкладки.
 *
 * HubShell сам скрывает вкладки без права: экономист без гранта `/discipline`
 * увидит только «KPI объектов», а руководитель участка — только дисциплину.
 */

const DisciplineAnalyticsPage = lazy(() => import('../DisciplineAnalyticsPage').then(m => ({ default: m.DisciplineAnalyticsPage })));
const ObjectKpiPage = lazy(() => import('../admin/ObjectKpiPage').then(m => ({ default: m.ObjectKpiPage })));

export const DisciplineHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'discipline',
      label: 'Дисциплина',
      accessPath: '/discipline',
      icon: BarChart3,
      render: () => <DisciplineAnalyticsPage />,
    },
    {
      key: 'objects',
      label: 'KPI объектов',
      accessPath: '/discipline/objects',
      icon: Building2,
      render: () => <ObjectKpiPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="discipline" />;
};
