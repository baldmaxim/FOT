import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { payrollRegistryService } from '../services/payrollRegistryService';
import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  type IPayrollTermsListResult,
  type IPayrollTermsViewParams,
  type PayrollPaidMonths,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../services/payrollService';
import { triggerBlobDownload } from '../utils/download';
import { buildPayrollCalcExport, type IPayrollCalcExportParams } from '../utils/payrollCalcExport';
import { calcColumnsQueryKey, calcPageRequests, mergeCalcColumns, type CalcQueryState } from '../utils/payrollCalcPages';
import { SNAPSHOT_EXPORT_MAX_ROWS } from './useSnapshotExport';

/** Порция списка «Расчётов» с месяцами, за которые она запрошена. */
type CalcListPage = IPayrollTermsListResult & { paidMonths: PayrollPaidMonths | null };

/** Что выбрано на экране в момент нажатия: загруженные порции и условия списка. */
export interface IPayrollCalcExportRequest extends Omit<IPayrollCalcExportParams, 'rows' | 'months'> {
  pages: readonly CalcListPage[];
  months: PayrollPaidMonths;
  viewParams: IPayrollTermsViewParams;
  sort: PayrollSortKey;
  dir: PayrollSortDir;
}

/** Порции, которых ещё нет на экране: тот же список, с курсора последней загруженной. */
const loadRemainingPages = async (request: IPayrollCalcExportRequest): Promise<CalcListPage[]> => {
  const { viewParams, sort, dir, months } = request;
  const pages = [...request.pages];
  let cursor = pages[pages.length - 1]?.meta.next_cursor ?? null;
  while (cursor) {
    const page = await payrollService.listTerms({
      ...viewParams, sort, dir, pageSize: PAYROLL_TERMS_PAGE_SIZE, cursor, paidMonths: months, deferCalc: true,
    });
    pages.push({ ...page, paidMonths: months });
    cursor = page.meta.next_cursor ?? null;
  }
  return pages;
};

/**
 * Столбцы ФОТ всех порций — по одной, как на экране: параллельные расчёты заняли бы пул БД. Ключ кэша экрана: посчитанное
 * не считается заново. Порция не посчиталась — ошибка наружу: неполной выгрузки с деньгами быть не должно. ФОТ за период
 * недоступен — остальные порции не запрашиваются, строки останутся без столбцов ФОТ, как на экране.
 */
const loadCalcRows = async (queryClient: QueryClient, pages: readonly CalcListPage[]) => {
  const requests = calcPageRequests(pages);
  const states: CalcQueryState[] = [];
  for (const request of requests) {
    const result = await queryClient.fetchQuery({
      queryKey: calcColumnsQueryKey(request),
      queryFn: ({ signal }) => payrollService.calcColumns(request.ids, request.months, signal),
      staleTime: 30_000,
      retry: false,
    });
    states.push({ status: 'success', result });
    if (!result.available) break;
  }
  return mergeCalcColumns(pages.flatMap(page => page.rows), requests, states).rows;
};

/**
 * «Экспорт» «Расчётов»: xlsx всей выборки экрана, а не только загруженных порций. Таблица на экране не меняется;
 * оформляет лист сервер, как у прочих снимков таблиц.
 */
export const usePayrollCalcExport = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const exportCalc = async (request: IPayrollCalcExportRequest) => {
    if (exporting) return;
    setExporting(true);
    try {
      const rows = await loadCalcRows(queryClient, await loadRemainingPages(request));
      if (rows.length > SNAPSHOT_EXPORT_MAX_ROWS) {
        toast.error(`Больше ${SNAPSHOT_EXPORT_MAX_ROWS} строк — сузьте фильтр`);
        return;
      }
      const { blob, filename } = await payrollRegistryService.exportTable('calc')(buildPayrollCalcExport({ ...request, rows }));
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось выгрузить таблицу');
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportCalc };
};
