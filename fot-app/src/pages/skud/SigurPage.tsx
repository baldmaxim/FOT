import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Scan, Settings } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { sigurService } from '../../services/sigurService';
import { useAuth } from '../../contexts/AuthContext';
import { CardReaderModal } from '../../components/skud/CardReaderModal';
import { SigurHelpPopover } from '../../components/skud/SigurHelpPopover';
import '../../styles/SigurSettingsPage.css';

const SigurEmployeesTab = lazy(() => import('../../components/skud/employees/SigurEmployeesTab').then(module => ({
  default: module.SigurEmployeesTab,
})));
const SigurAdminTab = lazy(() => import('../../components/skud/sigur-admin/SigurAdminTab').then(module => ({
  default: module.SigurAdminTab,
})));

const StructureSyncSection = lazy(() => import('../../components/skud/StructureSyncSection').then(module => ({
  default: module.StructureSyncSection,
})));
const EventsSyncSection = lazy(() => import('../../components/skud/EventsSyncSection').then(module => ({
  default: module.EventsSyncSection,
})));

type SigurView = 'employees' | 'settings' | 'sync';

const resolveView = (value: string | null): SigurView => {
  if (value === 'settings') return 'settings';
  if (value === 'sync') return 'sync';
  return 'employees';
};

export const SigurPage = () => {
  const { canEditPage, canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Кадровые операции Sigur — по своему ключу. Техника СКУД (очистка структуры и
  // событий, сопоставление, справочники точек и режимов доступа) остаётся за
  // /skud-settings: у кадровой роли этих кнопок быть не должно.
  const canEdit = canEditPage('/sigur');
  const canSkudTechnical = canEditPage('/skud-settings');
  // Точки и режимы доступа сотрудника — свой ключ, без остальной техники СКУД.
  const canManageAccessPoints = canSkudTechnical || canEditPage('/sigur/access-points');
  const canViewSkudTechnical = canViewPage('/skud-settings');
  const canUseReader = canViewPage('/skud-card-reader');

  const requestedView = resolveView(searchParams.get('view'));
  const view = requestedView === 'sync' && !canEdit ? 'employees' : requestedView;
  const [error, setError] = useState('');
  const [readerOpen, setReaderOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<{ sigurEmployeeId: number; fullName: string; key: number } | null>(null);

  // Пропсы блоков синхронизации: статус подключения и текущий фильтр отделов.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [syncFilterCount, setSyncFilterCount] = useState<number | null>(null);

  useEffect(() => {
    if (view !== 'sync') return;
    sigurService.getConnectionStatus()
      .then(result => setConnected(result.connected))
      .catch(() => { /* ложное «Нет связи» из-за сбоя status-fetch не показываем */ });
    sigurService.getSyncFilter()
      .then(filter => setSyncFilterCount(filter.length))
      .catch(() => setSyncFilterCount(null));
  }, [view]);

  const syncFilterSummary = syncFilterCount === null
    ? 'Фильтр отделов не загружен'
    : syncFilterCount === 0
      ? 'Фильтр синхронизации не задан: портальные sync-процессы работают со всеми отделами'
      : 'Для портальных sync-процессов выбрано: ' + syncFilterCount + ' отдел(ов)';

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

  const backButton = (
    <button
      className="sigur-btn sigur-fullpage__action"
      onClick={() => setView('employees')}
    >
      <ArrowLeft size={14} />
      Назад
    </button>
  );

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
      {canUseReader && <SigurHelpPopover />}
      {canEdit && (
        <button
          className="ep-toolbar-btn secondary sigur-fullpage__action"
          onClick={() => setView('sync')}
          title="Синхронизация структуры и событий Sigur с порталом"
        >
          <RefreshCw size={16} />
          <span>Синхронизация</span>
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
  ) : backButton;

  return (
    <div className="sigur-fullpage">
      {error && (
        <div className="sigur-error sigur-fullpage__error">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      <div className={`sigur-fullpage__content ${view === 'employees' ? '' : 'sigur-fullpage__content--padded'}`}>
        {view === 'employees' && (
          <Suspense fallback={tabFallback}>
            <SigurEmployeesTab
              canEdit={canEdit}
              canManageAccessPoints={canManageAccessPoints}
              canImportTabNumbers={canSkudTechnical}
              canDeleteDepartmentRecursive={canSkudTechnical}
              setError={setError}
              headerActionSlot={headerActionSlot}
              pendingOpen={pendingOpen}
            />
          </Suspense>
        )}

        {view === 'sync' && (
          <Suspense fallback={tabFallback}>
            <div className="sigur-fullpage__sync">
              <div className="sigur-fullpage__sync-header">{backButton}</div>
              <StructureSyncSection
                connected={connected}
                canEdit={canEdit}
                canClearStructure={canSkudTechnical}
                canMatchEmployees={canSkudTechnical}
                setError={setError}
                syncFilterSummary={syncFilterSummary}
                externalBusy={false}
              />
              <EventsSyncSection
                connected={connected}
                canClearEvents={canSkudTechnical}
                setError={setError}
                syncFilterSummary={syncFilterSummary}
                externalBusy={false}
              />
            </div>
          </Suspense>
        )}

        {view === 'settings' && (
          <Suspense fallback={tabFallback}>
            <SigurAdminTab
              canEdit={canEdit}
              canViewSkudTechnical={canViewSkudTechnical}
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
            onSigurEmployeeFound: (sigurEmployeeId, fullName) => {
              setReaderOpen(false);
              // Если открыты "Настройки" — переключаемся на "Сотрудники", чтобы открыть sidebar в нужном табе.
              if (view !== 'employees') setView('employees');
              setPendingOpen({ sigurEmployeeId, fullName, key: Date.now() });
            },
          }}
          onClose={() => setReaderOpen(false)}
        />
      )}
    </div>
  );
};
