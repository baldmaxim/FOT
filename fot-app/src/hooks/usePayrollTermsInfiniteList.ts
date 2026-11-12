import { useCallback, useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  type IPayrollTermsCursor,
  type IPayrollTermsViewParams,
  type PayrollPaidMonths,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../services/payrollService';
import { shouldLoadMore } from '../utils/staffLoadMore';

interface IPayrollTermsInfiniteListParams {
  viewParams: IPayrollTermsViewParams;
  sort: PayrollSortKey;
  dir: PayrollSortDir;
  date: string;
  /**
   * «Расчёты»: месяцы сумм таблицы; null — месяцы ещё грузятся, список ждёт.
   * Не передан — «Условия оплаты», сумм нет.
   */
  paidMonths?: PayrollPaidMonths | null;
  /** Список на экране: «Расчёты» догружают порции сами только на экране. */
  active: boolean;
}

/**
 * Список «Условий оплаты» и «Расчётов» порциями (курсор сервера): догрузка при прокрутке и повтор упавшей порции по
 * кнопке. На «Расчётах» порции грузятся сами, не дожидаясь прокрутки: «Итого», сортировка и фильтры сумм — по всей выборке.
 */
export const usePayrollTermsInfiniteList = ({
  viewParams, sort, dir, date, paidMonths, active,
}: IPayrollTermsInfiniteListParams) => {
  const isCalcScreen = paidMonths !== undefined;

  const termsQuery = useInfiniteQuery({
    queryKey: ['payroll-terms', 'infinite', viewParams, sort, dir, paidMonths ?? null],
    // Порция помнит месяцы, с которыми запрошена: пока грузится новый период, на экране прежние
    // строки (keepPreviousData) — и подпись периода должна оставаться их, а не уже выбранной.
    queryFn: async ({ pageParam, signal }) => ({
      ...await payrollService.listTerms({
        ...viewParams,
        sort,
        dir,
        pageSize: PAYROLL_TERMS_PAGE_SIZE,
        cursor: pageParam,
        paidMonths: paidMonths ?? undefined,
        // «Расчёты»: строки сразу, столбцы ФОТ — отдельными запросами (usePayrollCalcPageColumns).
        deferCalc: isCalcScreen,
      }, signal),
      paidMonths: paidMonths ?? null,
      // Дата порции: по ней считается «Выплачено» и подписи месяцев — строки прежней даты не смешаются с новой.
      date,
    }),
    initialPageParam: null as IPayrollTermsCursor | null,
    getNextPageParam: last => last.meta.next_cursor ?? undefined,
    enabled: paidMonths !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const {
    data, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, isPlaceholderData, fetchNextPage,
  } = termsQuery;

  const rows = useMemo(() => data?.pages.flatMap(page => page.rows) ?? [], [data]);

  // Синхронный флаг «порция уже запрошена»: isFetchingNextPage обновится только после рендера,
  // и быстрая прокрутка успела бы отправить одну и ту же порцию дважды.
  const inFlightRef = useRef(false);

  const loadMore = useCallback((lastVisibleIndex: number) => {
    const allowed = shouldLoadMore({
      lastVisibleIndex,
      loadedCount: rows.length,
      hasNextPage,
      inFlight: inFlightRef.current,
      isFetchingNextPage,
      isPlaceholderData,
      isFetchNextPageError,
    });
    if (!allowed) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  }, [rows.length, hasNextPage, isFetchingNextPage, isPlaceholderData, isFetchNextPageError, fetchNextPage]);

  // «Расчёты»: «Итого» — по всей выборке, поэтому порции грузятся сами, не дожидаясь прокрутки. По isFetching, а не по
  // inFlightRef: ref сбросится после рендера, и эффект, не увидев перемены, остановил бы догрузку. Упавшая — по кнопке.
  useEffect(() => {
    if (!isCalcScreen || !active || !hasNextPage) return;
    if (isFetching || isPlaceholderData || isFetchNextPageError) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [isCalcScreen, active, hasNextPage, isFetching, isPlaceholderData, isFetchNextPageError, fetchNextPage]);

  /** Повтор упавшей порции — только по кнопке: автоповтор у нижней границы дал бы цикл запросов. */
  const retryNextPage = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => { inFlightRef.current = false; });
  };

  return { termsQuery, rows, loadMore, retryNextPage };
};
