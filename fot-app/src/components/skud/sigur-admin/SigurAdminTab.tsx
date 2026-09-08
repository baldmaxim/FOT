import { Suspense, lazy, useCallback, type FC, type ReactNode } from 'react';
import { Briefcase, CreditCard, MapPin, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { SigurConnectionScope } from '../../../types';
import './SigurAdminTab.css';

const SigurPositionsSection = lazy(() => import('./SigurPositionsSection').then(m => ({ default: m.SigurPositionsSection })));
const SigurAccessPointsSection = lazy(() => import('./SigurAccessPointsSection').then(m => ({ default: m.SigurAccessPointsSection })));
const SigurCardsSection = lazy(() => import('./SigurCardsSection').then(m => ({ default: m.SigurCardsSection })));
const SigurAccessRulesSection = lazy(() => import('./SigurAccessRulesSection').then(m => ({ default: m.SigurAccessRulesSection })));

export type SigurAdminSubTab = 'positions' | 'access-points' | 'cards' | 'access-rules';

const SUB_TABS: SigurAdminSubTab[] = ['positions', 'access-points', 'cards', 'access-rules'];

const resolveSubTab = (value: string | null): SigurAdminSubTab => (
  value && SUB_TABS.includes(value as SigurAdminSubTab) ? (value as SigurAdminSubTab) : 'positions'
);

interface ISigurAdminTabProps {
  canEdit: boolean;
  /**
   * Технические справочники СКУД: должности, точки доступа, режимы доступа.
   * Кадровому админу не нужны — у него из этих подвкладок остаются только «Карты».
   */
  canViewSkudTechnical: boolean;
  selectedConnection: SigurConnectionScope;
  setError: (message: string) => void;
  headerActionSlot?: ReactNode;
}

export const SigurAdminTab: FC<ISigurAdminTabProps> = ({
  canEdit,
  canViewSkudTechnical,
  selectedConnection,
  setError,
  headerActionSlot,
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSub = resolveSubTab(searchParams.get('sub'));
  const isSubVisible = useCallback(
    (sub: SigurAdminSubTab) => canViewSkudTechnical || sub === 'cards',
    [canViewSkudTechnical],
  );
  // Без прав на технические справочники остаются только «Карты» — прямая ссылка
  // ?sub=access-rules не должна открывать раздел, которого у роли нет.
  const activeSub = isSubVisible(requestedSub) ? requestedSub : 'cards';

  const setActiveSub = useCallback((sub: SigurAdminSubTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (sub === 'positions') next.delete('sub');
      else next.set('sub', sub);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const sectionFallback = (
    <div className="sigur-admin-loading">Загрузка раздела...</div>
  );

  return (
    <div className="sigur-admin-root">
      <div className="sigur-admin-subtabs">
        {canViewSkudTechnical && (
          <button
            className={`sigur-admin-subtab ${activeSub === 'positions' ? 'active' : ''}`}
            onClick={() => setActiveSub('positions')}
          >
            <Briefcase size={14} />
            Должности
          </button>
        )}
        {canViewSkudTechnical && (
          <button
            className={`sigur-admin-subtab ${activeSub === 'access-points' ? 'active' : ''}`}
            onClick={() => setActiveSub('access-points')}
          >
            <MapPin size={14} />
            Точки доступа
          </button>
        )}
        <button
          className={`sigur-admin-subtab ${activeSub === 'cards' ? 'active' : ''}`}
          onClick={() => setActiveSub('cards')}
        >
          <CreditCard size={14} />
          Карты
        </button>
        {canViewSkudTechnical && (
          <button
            className={`sigur-admin-subtab ${activeSub === 'access-rules' ? 'active' : ''}`}
            onClick={() => setActiveSub('access-rules')}
          >
            <ShieldCheck size={14} />
            Режимы доступа
          </button>
        )}
        {headerActionSlot && (
          <div className="sigur-admin-subtabs__action">
            {headerActionSlot}
          </div>
        )}
      </div>

      <Suspense fallback={sectionFallback}>
        {activeSub === 'positions' && canViewSkudTechnical && (
          <SigurPositionsSection canEdit={canEdit} selectedConnection={selectedConnection} setError={setError} />
        )}
        {activeSub === 'access-points' && canViewSkudTechnical && (
          <SigurAccessPointsSection selectedConnection={selectedConnection} setError={setError} />
        )}
        {activeSub === 'cards' && (
          <SigurCardsSection selectedConnection={selectedConnection} setError={setError} />
        )}
        {activeSub === 'access-rules' && canViewSkudTechnical && (
          <SigurAccessRulesSection selectedConnection={selectedConnection} setError={setError} />
        )}
      </Suspense>
    </div>
  );
};
