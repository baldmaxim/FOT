import { Suspense, lazy, useCallback, useState } from 'react';
import { ArrowLeft, Settings } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import '../../styles/SigurSettingsPage.css';

const SigurEmployeesTab = lazy(() => import('../../components/skud/employees/SigurEmployeesTab').then(module => ({
  default: module.SigurEmployeesTab,
})));
const SigurAdminTab = lazy(() => import('../../components/skud/sigur-admin/SigurAdminTab').then(module => ({
  default: module.SigurAdminTab,
})));

type SigurView = 'employees' | 'settings';

const resolveView = (value: string | null): SigurView => (
  value === 'settings' ? 'settings' : 'employees'
);

export const SigurPage = () => {
  const { canEditPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = canEditPage('/skud-settings');

  const view = resolveView(searchParams.get('view'));
  const [error, setError] = useState('');

  const setView = useCallback((nextView: SigurView) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (nextView === 'employees') {
        next.delete('view');
        next.delete('sub');
      } else {
        next.set('view', nextView);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const tabFallback = (
    <div className="sigur-loading">
      Загрузка...
    </div>
  );

  return (
    <div className="sigur-fullpage">
      <div className="sigur-fullpage__bar">
        <button
          className="sigur-btn"
          onClick={() => setView(view === 'employees' ? 'settings' : 'employees')}
        >
          {view === 'employees' ? <><Settings size={14} /> Настройка</> : <><ArrowLeft size={14} /> Назад</>}
        </button>
      </div>

      {error && (
        <div className="sigur-error sigur-fullpage__error">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      <div className={`sigur-fullpage__content ${view === 'settings' ? 'sigur-fullpage__content--padded' : ''}`}>
        {view === 'employees' && (
          <Suspense fallback={tabFallback}>
            <SigurEmployeesTab
              canEdit={canEdit}
              setError={setError}
            />
          </Suspense>
        )}

        {view === 'settings' && (
          <Suspense fallback={tabFallback}>
            <SigurAdminTab
              canEdit={canEdit}
              selectedConnection="external"
              setError={setError}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
};
