import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { DORMITORY_STAYS_KEY } from '../../../services/dormitoryService';
import {
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IHousingAllowanceRow,
  type IPayrollSupplementRow,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  canEditSupplement,
  housingRowKey,
  plannedRemoval,
  stayRemoval,
  supplementPeriod,
  supplementRowKey,
} from '../../../utils/payrollRegistries';

/**
 * 🗑 «Убрать» и перечитывание в «Доплате» и её списках («Плановые доплаты», «Квартира»): одна логика на три окна.
 * Плановая (любой период, по id строки журнала) — убрать с 1-го числа текущего месяца (период закрывается, прошлые
 * месяцы остаются) или снять ошибочную. Разовая — удалить. Квартира —
 * выезд 1-м числом текущего месяца или удалить не начавшееся / прошедшее проживание. busyKey — ключ строки,
 * которая сейчас убирается (supplementRowKey / housingRowKey).
 */
export const useSupplementRemoval = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Плановая — та же, что в окне сотрудника: префикс перечитывает и список «Расчётов», и окно, и таблицы «Справочника».
  const refreshSupplements = () => queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });
  // Квартира — ещё и вкладка кадров «Проживание».
  const refreshHousing = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY }),
  ]);

  const run = async (key: string, action: () => Promise<void>, refresh: () => Promise<unknown>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  const removeSupplement = async (row: IPayrollSupplementRow) => {
    if (busyKey !== null || !canEditSupplement(row)) return;
    const removal = plannedRemoval(row, moscowTodayIso());
    let question: string;
    if (removal?.action === 'close') {
      question = `Убрать плановую доплату у ${row.full_name} с ${formatDate(removal.cutoff)}? `
        + `Период ${formatDate(row.date_from)} – ${formatDate(removal.dateTo)} останется в истории.`;
    } else if (row.kind === 'planned') {
      question = `Снять плановую доплату у ${row.full_name} (${supplementPeriod(row)})?`;
    } else {
      question = `Удалить разовую доплату у ${row.full_name} за ${supplementPeriod(row)}?`;
    }
    if (!window.confirm(question)) return;
    await run(supplementRowKey(row), async () => {
      if (removal?.action === 'close' && row.date_from !== null) {
        const fields = { amount: Number(row.amount), date_from: row.date_from, date_to: removal.dateTo };
        if (row.id !== null) await payrollRegistryService.updatePlannedPeriod(row.id, fields);
        else await payrollRegistryService.setPlanned(row.employee_id, fields);
      } else if (row.kind === 'planned') {
        if (row.id !== null) await payrollRegistryService.removePlannedPeriod(row.id);
        else await payrollRegistryService.removePlanned(row.employee_id);
      } else if (row.id !== null) {
        await payrollRegistryService.removeOneTime(row.id);
      }
    }, refreshSupplements);
  };

  const removeHousing = async (row: IHousingAllowanceRow) => {
    if (busyKey !== null) return;
    const removal = stayRemoval(row, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать квартиру у ${row.full_name} с ${formatDate(removal.checkOut)}? Прошлые месяцы останутся в истории.`
      : `Удалить ошибочную строку: ${row.full_name}, въезд ${formatDate(row.check_in)}?`;
    if (!window.confirm(question)) return;
    await run(housingRowKey(row), async () => {
      if (removal.action === 'close') {
        await payrollRegistryService.updateHousing(row.id, {
          check_in: row.check_in, check_out: removal.checkOut, amount: Number(row.amount), address: row.address,
        });
      } else {
        await payrollRegistryService.removeHousing(row.id);
      }
    }, refreshHousing);
  };

  return { busyKey, removeSupplement, removeHousing, refreshSupplements, refreshHousing };
};
