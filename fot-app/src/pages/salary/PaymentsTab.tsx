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
const PayrollDeductionsPage = lazy(() => import('./PayrollDeductionsPage').then(m => ({ default: m.PayrollDeductionsPage })));

/**
 * Вкладка «Выплаты». Внутри экраны:
 *  - «Условия оплаты» — список сотрудников с условиями (рабочий экран, по умолчанию);
 *  - «Подробно» — карточка сотрудника, которого открыли кликом по строке списка;
 *  - «Расчёты» — тот же список без массового назначения, с фильтром «Удержания» за месяц; карточка — в окне;
 *  - «Администрирование» — подключение по API к 1С и другим системам (пока заглушка).
 *
 * Экран хранится в ?view=, а не в ?tab=: tab занят HubShell, и setSearchParams
 * хаба сохраняет остальные параметры. Списки и карточка при смене экрана не размонтируются:
 * фильтры, выделение, прокрутка и введённое в карточке сохраняются.
 */
export const PaymentsTab: FC = () => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canTerms = canViewPage('/salary/terms');
  // «Расчёты» — список и карточка условий оплаты: нужен и ключ /salary/terms.
  const canCalc = canTerms && canViewPage('/salary/payments');
  const canAdmin = canViewPage('/salary/admin');
  const views = paymentsViewOptions(canTerms, canCalc, canAdmin);
  const view = resolvePaymentsView(searchParams.get('view'), views);

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня» по Москве,
  // как на сервере. Дата браузера в другом поясе давала бы соседний день. Ею же карточка
  // предзаполняет «Действует с».
  const [date] = useState(moscowTodayIso);
  // Сотрудник вкладки «Подробно» — строка списка на момент клика.
  const [details, setDetails] = useState<IPayrollTermsRow | null>(null);
  // «Расчёты» монтируются при первом заходе и дальше остаются (скрытыми): второй список не строится зря.
  const [calcMounted, setCalcMounted] = useState(false);
  if (view === 'calc' && !calcMounted) setCalcMounted(true);

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

  // Массовое назначение со списка и сохранение в окне «Расчётов»: карточка «Подробно» в этот момент
  // скрыта, экран не меняется — устаревшая карточка этих сотрудников закрывается.
  const handleAssigned = useCallback((employeeIds: number[]) => {
    setDetails(prev => dropPayrollDetails(prev, employeeIds));
  }, []);
  const handleCalcSaved = useCallback((employeeId: number) => handleAssigned([employeeId]), [handleAssigned]);

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
            />
          </div>
        )}

        {view === 'details' && !details && (
          <div className={styles.view}>
            <p className={styles.empty}>Выберите сотрудника в «Условиях оплаты»</p>
          </div>
        )}

        {canCalc && calcMounted && (
          <div className={view === 'calc' ? styles.view : styles.viewHidden}>
            <Suspense fallback={<div className={styles.loading}>Загрузка…</div>}>
              <PayrollDeductionsPage date={date} active={view === 'calc'} onSaved={handleCalcSaved} />
            </Suspense>
          </div>
        )}

        {view === 'admin' && (
          <div className={styles.view}>
            <SalaryTabPlaceholder
              title="Администрирование"
              description="Подключение по API к 1С и другим системам."
            />
          </div>
        )}
      </div>
    </div>
  );
};
