import { lazy, startTransition, Suspense, useCallback, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../contexts/AuthContext';
import { payrollService, type IPayrollTermsRow } from '../../services/payrollService';
import { moscowTodayIso } from '../../utils/moscowDate';
import {
  calcMonthFilterOf,
  calcViewFilters,
  dropPayrollDetails,
  EMPTY_CALC_MONTH_FILTER,
  openPayrollDetails,
  paymentsViewOptions,
  readPayrollReturn,
  resolvePaymentsView,
  type ICalcFocus,
  type ICalcMonthFilter,
  type IPayrollCardView,
  type IPayrollReturn,
  type PaymentsView,
} from '../../utils/payrollViews';
import { EmployeePayrollDetails } from '../../components/salary/EmployeePayrollDetails';
import styles from './PaymentsTab.module.css';

const CompensationTermsPage = lazy(() => import('./CompensationTermsPage').then(m => ({ default: m.CompensationTermsPage })));
const PayrollDeductionsPage = lazy(() => import('./PayrollDeductionsPage').then(m => ({ default: m.PayrollDeductionsPage })));

/**
 * Вкладка «Выплаты». Внутри экраны:
 *  - «Условия оплаты» — список сотрудников с условиями (рабочий экран, по умолчанию);
 *  - «Подробно» — карточка сотрудника, которого открыли кликом по строке списка;
 *  - «Расчёты» — тот же список со «Справочником» удержаний и ставок; карточка — в окне. Открыли карточку в
 *    «Подробно» — там только этот сотрудник, пока на «Расчётах» не сняли (крестик в поиске, правка, отдел).
 *
 * Экран хранится в ?view=, а не в ?tab=: tab занят HubShell, и setSearchParams
 * хаба сохраняет остальные параметры. Списки и карточка при смене экрана не размонтируются:
 * фильтры, прокрутка и введённое в карточке сохраняются.
 *
 * Клик по ФИО в «Подробно» уводит на карточку посещаемости, и страница размонтируется: перед уходом запись истории
 * браузера запоминает сотрудника, месяцы, поиск и отдел. На возврате строку сотрудника читаем заново с сервера.
 */
export const PaymentsTab: FC = () => {
  const { canViewPage } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [restore] = useState(() => readPayrollReturn(location.state));
  // Сотрудник, чью строку ещё ждём после возврата с карточки посещаемости.
  const [restoreId, setRestoreId] = useState(restore?.employeeId ?? null);

  const canTerms = canViewPage('/salary/terms');
  // «Расчёты» — список и карточка условий оплаты: нужен и ключ /salary/terms.
  const canCalc = canTerms && canViewPage('/salary/payments');
  const views = paymentsViewOptions(canTerms, canCalc);
  const view = resolvePaymentsView(searchParams.get('view'), views);

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня» по Москве,
  // как на сервере. Дата браузера в другом поясе давала бы соседний день. Ею же карточка
  // предзаполняет «Действует с».
  const [date] = useState(moscowTodayIso);
  // Поиск по ФИО — один на «Условия оплаты» и «Расчёты».
  const [search, setSearch] = useState(restore?.search ?? '');
  // Отдел или бригада — тоже один на оба списка.
  const [departmentId, setDepartmentId] = useState(restore?.departmentId ?? '');
  // Сотрудник вкладки «Подробно» — строка списка на момент клика.
  const [details, setDetails] = useState<IPayrollTermsRow | null>(null);
  // «Расчёты» — только сотрудник, открытый кликом в «Условиях оплаты»; сохранение в окне «Расчётов» не снимает.
  const [calcFocus, setCalcFocus] = useState<ICalcFocus | null>(restore?.calcFocus ?? null);
  const calcFilters = calcViewFilters(calcFocus, search, departmentId);
  // Группа (ИТР / Рабочие в «Все отделы») — общая с «Условиями оплаты», как отдел; «Объект» месяца — только у «Расчётов».
  // При открытой карточке «Расчёты» показывают «Все».
  const [calcMonthFilter, setCalcMonthFilter] = useState<ICalcMonthFilter>(restore?.calcMonthFilter ?? EMPTY_CALC_MONTH_FILTER);
  const shownMonthFilter = calcMonthFilterOf(calcFocus, calcMonthFilter);
  // «Расчёты» монтируются при первом заходе и дальше остаются (скрытыми): второй список не строится зря.
  const [calcMounted, setCalcMounted] = useState(false);
  if (view === 'calc' && !calcMounted) setCalcMounted(true);

  const returnRow = useQuery({
    queryKey: ['payroll-terms', 'return-row', restoreId, date],
    queryFn: ({ signal }) => payrollService.listTerms(
      { date, employeeId: restoreId as number, sort: 'name', dir: 'asc', pageSize: 1 },
      signal,
    ),
    enabled: canTerms && restoreId !== null,
    // Строку не кэшируем: на возврате нужна свежая, а в приложении refetchOnMount: false — кэш вернулся бы без запроса.
    gcTime: 0,
  });
  // Ждём конца запроса. Условие разовое: restoreId сразу сбрасывается.
  if (restoreId !== null && !returnRow.isFetching) {
    setRestoreId(null);
    // Сверка id: сервер, не знающий фильтра, вернул бы другого человека.
    const row = returnRow.isSuccess
      ? returnRow.data.rows.find(item => item.employee_id === restoreId)
      : undefined;
    if (row) setDetails(prev => prev ?? row);
  }

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
    startTransition(() => {
      setDetails(prev => openPayrollDetails(prev, row));
      setCalcFocus({ employeeId: row.employee_id, fullName: row.full_name });
    });
    selectView('details', true);
  }, [selectView]);

  // Правка поиска или отдела на «Расчётах» снимает «только он»; крестик в поиске — общая таблица.
  const handleCalcSearch = useCallback((value: string) => {
    setCalcFocus(null);
    setSearch(value);
  }, [setSearch]);
  const handleCalcDepartment = useCallback((id: string) => {
    setCalcFocus(null);
    setDepartmentId(id);
  }, [setDepartmentId]);
  const handleCalcMonthFilter = useCallback((next: ICalcMonthFilter) => {
    setCalcFocus(null);
    setCalcMonthFilter(next);
  }, [setCalcMonthFilter]);

  // Сохранение в окне «Расчётов»: карточка «Подробно» в этот момент скрыта, экран не меняется —
  // устаревшая карточка этого сотрудника закрывается.
  const handleCalcSaved = useCallback((employeeId: number) => {
    setDetails(prev => dropPayrollDetails(prev, [employeeId]));
  }, []);

  // Клик по ФИО: стрелка назад вернётся на эту запись истории — кладём в неё, что показать.
  const rememberReturn = useCallback((card: IPayrollCardView) => {
    if (!details) return;
    const payrollReturn: IPayrollReturn = {
      employeeId: details.employee_id, card, search, departmentId, calcFocus, calcMonthFilter,
    };
    setSearchParams(prev => prev, { replace: true, state: { payrollReturn } });
  }, [details, search, departmentId, calcFocus, calcMonthFilter, setSearchParams]);

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
                search={search}
                onSearchChange={setSearch}
                departmentId={departmentId}
                onDepartmentChange={setDepartmentId}
                monthFilter={calcMonthFilter}
                onMonthFilterChange={setCalcMonthFilter}
                onOpenEmployee={openEmployee}
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
              initialView={details.employee_id === restore?.employeeId ? restore.card : undefined}
              onLeaveToEmployeeCard={rememberReturn}
            />
          </div>
        )}

        {view === 'details' && !details && (
          <div className={styles.view}>
            {restoreId !== null
              ? <div className={styles.loading}>Загрузка…</div>
              : <p className={styles.empty}>Выберите сотрудника в «Условиях оплаты»</p>}
          </div>
        )}

        {canCalc && calcMounted && (
          <div className={view === 'calc' ? styles.view : styles.viewHidden}>
            <Suspense fallback={<div className={styles.loading}>Загрузка…</div>}>
              <PayrollDeductionsPage
                date={date}
                active={view === 'calc'}
                employeeId={calcFilters.employeeId}
                search={calcFilters.search}
                onSearchChange={handleCalcSearch}
                departmentId={calcFilters.departmentId}
                onDepartmentChange={handleCalcDepartment}
                monthFilter={shownMonthFilter}
                onMonthFilterChange={handleCalcMonthFilter}
                onSaved={handleCalcSaved}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
};
