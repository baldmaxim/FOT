import { lazy, Suspense, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../contexts/AuthContext';
import { SalaryTabPlaceholder } from '../../components/salary/SalaryTabPlaceholder';
import styles from './PaymentsTab.module.css';

const CompensationTermsPage = lazy(() => import('./CompensationTermsPage').then(m => ({ default: m.CompensationTermsPage })));

type PaymentsView = 'terms' | 'calc';

/**
 * Вкладка «Выплаты». Внутри два экрана:
 *  - «Условия оплаты» — категория и вид оплаты сотрудника (рабочий экран, по умолчанию);
 *  - «Расчёт и выплаты» — аванс, базовая и премиальная часть (этапы 2–3).
 *
 * Экран хранится в ?view=, а не в ?tab=: tab занят HubShell, и setSearchParams
 * хаба сохраняет остальные параметры.
 */
export const PaymentsTab: FC = () => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canTerms = canViewPage('/salary/terms');
  const canCalc = canViewPage('/salary/payments');

  const requested = searchParams.get('view') as PaymentsView | null;
  const view: PaymentsView = requested === 'calc' && canCalc
    ? 'calc'
    : canTerms ? 'terms' : 'calc';

  const selectView = (next: PaymentsView) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      params.set('view', next);
      return params;
    }, { replace: false });
  };

  const showSwitch = canTerms && canCalc;

  return (
    <div className={styles.tab}>
      {showSwitch && (
        <div className={styles.switch} role="tablist" aria-label="Экраны вкладки «Выплаты»">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'terms'}
            className={`${styles.switchButton} ${view === 'terms' ? styles.switchActive : ''}`}
            onClick={() => selectView('terms')}
          >
            Условия оплаты
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'calc'}
            className={`${styles.switchButton} ${view === 'calc' ? styles.switchActive : ''}`}
            onClick={() => selectView('calc')}
          >
            Расчёт и выплаты
          </button>
        </div>
      )}

      {view === 'terms' ? (
        <Suspense fallback={<div className={styles.loading}>Загрузка…</div>}>
          <CompensationTermsPage />
        </Suspense>
      ) : (
        <SalaryTabPlaceholder
          title="Расчёт и выплаты"
          description="Расчёт оклада и часов по закрытым табелям, затем аванс, базовая и премиальная часть с фактическими выплатами и остатком."
          stage="Расчёт — этап 2, выплаты — этап 3"
        />
      )}
    </div>
  );
};
