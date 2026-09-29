import { lazy, startTransition, Suspense, useCallback, useState, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../contexts/AuthContext';
import type { IPayrollTermsRow } from '../../services/payrollService';
import { moscowTodayIso } from '../../utils/moscowDate';
import {
  dropPayrollDetails,
  openPayrollDetails,
  paymentsViewOptions,
  resolvePaymentsView,
  type PaymentsView,
} from '../../utils/payrollViews';
import { EmployeePayrollDetails } from '../../components/salary/EmployeePayrollDetails';
import { SalaryTabPlaceholder } from '../../components/salary/SalaryTabPlaceholder';
import styles from './PaymentsTab.module.css';

const CompensationTermsPage = lazy(() => import('./CompensationTermsPage').then(m => ({ default: m.CompensationTermsPage })));

/**
 * Вкладка «Выплаты». Внутри экраны:
 *  - «Условия оплаты» — список сотрудников с условиями (рабочий экран, по умолчанию);
 *  - «Подробно» — карточка сотрудника, которого открыли кликом по строке списка;
 *  - «Расчёт и выплаты» — аванс, базовая и премиальная часть (этапы 2–3).
 *
 * Экран хранится в ?view=, а не в ?tab=: tab занят HubShell, и setSearchParams
 * хаба сохраняет остальные параметры. Список и карточка при смене экрана не размонтируются:
 * фильтры, выделение, прокрутка и введённое в карточке сохраняются.
 */
export const PaymentsTab: FC = () => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canTerms = canViewPage('/salary/terms');
  const canCalc = canViewPage('/salary/payments');
  const views = paymentsViewOptions(canTerms, canCalc);
  const view = resolvePaymentsView(searchParams.get('view'), views);

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня» по Москве,
  // как на сервере. Дата браузера в другом поясе давала бы соседний день. Ею же карточка
  // предзаполняет «Действует с».
  const [date] = useState(moscowTodayIso);
  // Сотрудник вкладки «Подробно» — строка списка на момент клика.
  const [details, setDetails] = useState<IPayrollTermsRow | null>(null);

  /**
   * Клики по вкладкам пишутся в историю браузера. Открытие и закрытие карточки — нет (replace),
   * как было с окном: «Назад» уводит из раздела, а не листает карточки.
   */
  const selectView = useCallback((next: PaymentsView, replace = false) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      params.set('view', next);
      return params;
    }, { replace });
  }, [setSearchParams]);

  // Роутер меняет ?view= переходом (startTransition) — карточку меняем в том же переходе.
  // Иначе React отрисует её раньше экрана: пустая «Подробно» мелькнёт на кадр, а autoFocus
  // сработает на ещё скрытой карточке.
  const openEmployee = useCallback((row: IPayrollTermsRow) => {
    startTransition(() => setDetails(prev => openPayrollDetails(prev, row)));
    selectView('details', true);
  }, [selectView]);

  const closeDetails = useCallback(() => {
    startTransition(() => setDetails(null));
    selectView('terms', true);
  }, [selectView]);

  // Сохранение закрывает карточку этого сотрудника (её форма собрана до него); к списку — только
  // если она ещё на экране: вкладку могли сменить, пока шёл запрос.
  const handleSaved = useCallback((employeeId: number, onScreen: boolean) => {
    startTransition(() => setDetails(prev => dropPayrollDetails(prev, [employeeId])));
    if (onScreen) selectView('terms', true);
  }, [selectView]);

  // Массовое назначение идёт со списка: карточка в этот момент скрыта, экран не меняется.
  const handleAssigned = useCallback((employeeIds: number[]) => {
    setDetails(prev => dropPayrollDetails(prev, employeeIds));
  }, []);

  return (
    <div className={styles.tab}>
      {views.length > 1 && (
        <div className={styles.switch} role="tablist" aria-label="Экраны вкладки «Выплаты»">
          {views.map(option => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={view === option.key}
              className={`${styles.switchButton} ${view === option.key ? styles.switchActive : ''}`}
              onClick={() => selectView(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <div className={styles.views}>
        {canTerms && (
          <div className={view === 'terms' ? styles.view : styles.viewHidden}>
            <Suspense fallback={<div className={styles.loading}>Загрузка…</div>}>
              <CompensationTermsPage
                date={date}
                active={view === 'terms'}
                onOpenEmployee={openEmployee}
                onAssigned={handleAssigned}
              />
            </Suspense>
          </div>
        )}

        {canTerms && details && (
          <div className={view === 'details' ? styles.view : styles.viewHidden}>
            <EmployeePayrollDetails
              key={details.employee_id}
              row={details}
              defaultDate={date}
              active={view === 'details'}
              onClose={closeDetails}
              onSaved={handleSaved}
            />
          </div>
        )}

        {view === 'details' && !details && (
          <div className={styles.view}>
            <p className={styles.empty}>Выберите сотрудника в «Условиях оплаты»</p>
          </div>
        )}

        {view === 'calc' && (
          <div className={styles.view}>
            <SalaryTabPlaceholder
              title="Расчёт и выплаты"
              description="Расчёт оклада и часов по закрытым табелям, затем аванс, базовая и премиальная часть с фактическими выплатами и остатком."
              stage="Расчёт — этап 2, выплаты — этап 3"
            />
          </div>
        )}
      </div>
    </div>
  );
};
