import { useMemo, useState, type FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PAYROLL_RATES_KEY, usePayrollRates } from '../../hooks/usePayrollRates';
import { PAYROLL_TERMS_PREFIX } from '../../services/payrollRegistryService';
import {
  DORMITORY_ALLOWANCE_RATE_CODE,
  HOUSING_RATE_CODE,
  payrollService,
  type IPayrollRate,
} from '../../services/payrollService';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { rateMonthOptions } from '../../utils/payrollRates';
import { PayrollDictionarySection } from './PayrollDictionarySection';

interface IPayrollRatesEditorProps {
  canEdit: boolean;
}

/**
 * «Ставки» в окне «Справочник»: значение ставки — изменить с выбранного месяца (миграция 324): прошлые месяцы
 * остаются при прежнем значении. Новых ставок здесь не заводят (миграции 313/315/317/324); у ставки с кодом
 * название не меняется и удалить её нельзя. Значение «Доплаты за проживание» — ставка за день по умолчанию при
 * добавлении сотрудника в список «Квартира» («Доплата» в шапке). «Доплата за общежитие» — ставка за день членам бригад
 * за отработанные дни, кроме дней в «Общежитии» и «Квартире» (миграция 339). «Проезд» — сумма за месяц всем, кроме
 * «Рабочих» и «Без проезда».
 */

/** Ставки проживания — за день (миграция 339); остальные — без единицы. */
const rateUnit = (item: { code?: string | null }): string | null => (
  item.code === HOUSING_RATE_CODE || item.code === DORMITORY_ALLOWANCE_RATE_CODE ? '₽/день' : null
);
export const PayrollRatesEditor: FC<IPayrollRatesEditorProps> = ({ canEdit }) => {
  const rates = usePayrollRates();
  const queryClient = useQueryClient();
  // Текущий месяц — на момент открытия окна: выбор «с какого месяца» начинается с него.
  const [currentMonth] = useState(moscowCurrentMonth);
  const monthOptions = useMemo(() => rateMonthOptions(currentMonth), [currentMonth]);

  /**
   * Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне.
   * Ставки показывают и список «Расчётов» (проезд в карточке), и листок, и таблицы «Справочника» — префикс
   * 'payroll-terms' перечитывает их.
   */
  const apply = async (action: () => Promise<(list: IPayrollRate[]) => IPayrollRate[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IPayrollRate[]>(PAYROLL_RATES_KEY, list => (list ? change(list) : list));
    } finally {
      void queryClient.invalidateQueries({ queryKey: PAYROLL_RATES_KEY });
      void queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });
    }
  };

  return (
    <PayrollDictionarySection
      title="Ставки"
      items={rates.data}
      isError={rates.isError}
      onRetry={() => { void rates.refetch(); }}
      nameLabel="Ставка"
      amountLabel="Значение"
      amountUnit={rateUnit}
      monthOptions={monthOptions}
      canEdit={canEdit}
      deleteQuestion={name => `Удалить ставку «${name}»?`}
      isLocked={item => Boolean(item.code)}
      onUpdate={(id, payload) => apply(async () => {
        const updated = await payrollService.updateRate(id, payload);
        return list => list.map(rate => (rate.id === id ? updated : rate));
      })}
      onDelete={id => apply(async () => {
        await payrollService.deleteRate(id);
        return list => list.filter(rate => rate.id !== id);
      })}
    />
  );
};
