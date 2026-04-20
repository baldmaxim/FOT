import { lazy, Suspense, type FC } from 'react';

const SigurSettingsPage = lazy(() => import('../skud/SigurSettingsPage').then(m => ({ default: m.SigurSettingsPage })));

export const SkudHubPage: FC = () => (
  <Suspense fallback={<div style={{ padding: 16 }}>Загрузка...</div>}>
    <SigurSettingsPage />
  </Suspense>
);
