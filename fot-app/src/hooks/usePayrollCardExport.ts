import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { payrollService, type IPayrollTermsRow } from '../services/payrollService';
import { triggerBlobDownload } from '../utils/download';
import { moscowTodayIso } from '../utils/moscowDate';
import { buildPayrollCardExport } from '../utils/payrollCardExport';
import { calcMonthSums } from '../utils/payrollCalc';
import { paidHistory, recentHistoryMonths } from '../utils/payrollPaid';
import { paidHistoryQueryOptions, payouts1cHistoryQueryOptions, payslipQueryOptions } from './usePayrollPaid';

/**
 * «Экспорт» карточки сотрудника: xlsx с условиями (row на момент открытия карточки) и историей выплат.
 * История и «Перечислено (1С)» — теми же запросами, что вкладка «История выплат» (toMonth карточки): открытая
 * не грузится заново.
 * asOfDate — дата выборки условий; имя файла — по дате выгрузки по Москве.
 */
export const usePayrollCardExport = (row: IPayrollTermsRow, asOfDate: string, toMonth: string) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const exportCard = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const [paidRows, payouts] = await Promise.all([
        queryClient.fetchQuery(paidHistoryQueryOptions(row.employee_id, toMonth)),
        queryClient.fetchQuery(payouts1cHistoryQueryOptions(row.employee_id, toMonth)),
      ]);
      // Те же месяцы и суммы, что на вкладке «Зарплата»; расчёт месяца не загрузился — суммы 1С, выгрузка не падает.
      const recentMonths = recentHistoryMonths(toMonth);
      const months = paidHistory(paidRows, payouts, recentMonths).months.map(entry => entry.month);
      const payslips = await Promise.allSettled(
        months.map(month => queryClient.fetchQuery(payslipQueryOptions(row.employee_id, month))),
      );
      const byMonth = new Map(months.map((month, index) => {
        const payslip = payslips[index];
        return [month, payslip.status === 'fulfilled' ? calcMonthSums(payslip.value.calc) : null];
      }));
      const snapshot = buildPayrollCardExport({
        row, paidRows, payouts, fot: { recentMonths, byMonth }, asOfDate, exportedAt: moscowTodayIso(),
      });
      const { blob, filename } = await payrollService.exportCard(snapshot);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось выгрузить карточку');
    } finally {
      setExporting(false);
    }
  };

  return { exporting, exportCard };
};
