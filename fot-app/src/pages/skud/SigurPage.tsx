import { Suspense, lazy, useCallback, useState } from 'react';
import { ArrowLeft, Scan, Settings } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { CardReaderModal } from '../../components/skud/CardReaderModal';
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
  const { canEditPage, canViewPage } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = canEditPage('/skud-settings');
  const canUseReader = canViewPage('/skud-card-reader');

  const view = resolveView(searchParams.get('view'));
  const [error, setError] = useState('');
  const [readerOpen, setReaderOpen] = useState(false);

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

  const headerActionSlot = view === 'employees' ? (
    <>
      {canUseReader && (
        <button
          className="ep-toolbar-btn secondary sigur-fullpage__action"
          onClick={() => setReaderOpen(true)}
          title="Считать пропуск через USB-считыватель"
        >
          <Scan size={16} />
          <span>Считать пропуск</span>
        </button>
      )}
      <button
        className="ep-toolbar-btn secondary sigur-fullpage__action"
        onClick={() => setView('settings')}
      >
        <Settings size={16} />
        <span>Настройка</span>
      </button>
    </>
  ) : (
    <button
      className="sigur-btn sigur-fullpage__action"
      onClick={() => setView('employees')}
    >
      <ArrowLeft size={14} />
      Назад
    </button>
  );

  return (
    <div className="sigur-fullpage">
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
              headerActionSlot={headerActionSlot}
            />
          </Suspense>
        )}

        {view === 'settings' && (
          <Suspense fallback={tabFallback}>
            <SigurAdminTab
              canEdit={canEdit}
              selectedConnection="external"
              setError={setError}
              headerActionSlot={headerActionSlot}
            />
          </Suspense>
        )}
      </div>

      {readerOpen && (
        <CardReaderModal
          mode={{
            kind: 'lookup',
            onEmployeeFound: (employeeId) => {
              setReaderOpen(false);
              navigate(`/employees/${employeeId}`);
            },
          }}
          onClose={() => setReaderOpen(false)}
        />
      )}
    </div>
  );
};
