import { lazy, useMemo, type FC } from 'react';
import { BarChart3, Settings, MapPin } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const SkudMonitorPage = lazy(() => import('../skud/SkudMonitorPage').then(m => ({ default: m.SkudMonitorPage })));
const SigurSettingsPage = lazy(() => import('../skud/SigurSettingsPage').then(m => ({ default: m.SigurSettingsPage })));
const TravelSegmentsPage = lazy(() => import('../skud/TravelSegmentsPage').then(m => ({ default: m.TravelSegmentsPage })));

export const SkudHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'monitor',
      label: 'Монитор',
      accessPath: '/skud-monitor',
      icon: BarChart3,
      render: () => <SkudMonitorPage />,
    },
    {
      key: 'settings',
      label: 'Настройки',
      accessPath: '/skud-settings',
      icon: Settings,
      render: () => <SigurSettingsPage />,
    },
    {
      key: 'travel',
      label: 'Передвижения',
      accessPath: '/skud-travel',
      icon: MapPin,
      render: () => <TravelSegmentsPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="monitor" />;
};
