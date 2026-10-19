import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PAYROLL_RATES_KEY, usePayrollRates } from '../../hooks/usePayrollRates';
import { HOUSING_RATE_CODE, payrollService, type IPayrollRate } from '../../services/payrollService';
import { PayrollDictionarySection } from './PayrollDictionarySection';
import { PayrollEmployeesButton } from './PayrollEmployeesButton';

interface IPayrollRatesEditorProps {
  canEdit: boolean;
  /** Название и кнопка «Сотрудники» у «Доплаты за проживание»: таблица сотрудников с доплатой. */
  onOpenHousing: () => void;
}

/**
 * «Ставки» в окне «Справочник»: значение ставки — изменить. Новых ставок здесь не заводят (миграции 313/315);
 * у ставки с кодом название не меняется и удалить её нельзя. Значение «Доплаты за проживание» — сумма по
 * умолчанию при добавлении сотрудника в её таблицу; в окно сотрудника и в расчёты не подставляется.
 */
export const PayrollRatesEditor: FC<IPayrollRatesEditorProps> = ({ canEdit, onOpenHousing }) => {
  const rates = usePayrollRates();
  const queryClient = useQueryClient();

  /** Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне. */
  const apply = async (action: () => Promise<(list: IPayrollRate[]) => IPayrollRate[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IPayrollRate[]>(PAYROLL_RATES_KEY, list => (list ? change(list) : list));
    } finally {
      void queryClient.invalidateQueries({ queryKey: PAYROLL_RATES_KEY });
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
      canEdit={canEdit}
      deleteQuestion={name => `Удалить ставку «${name}»?`}
      isLocked={item => Boolean(item.code)}
      renderExtraAction={item => (item.code === HOUSING_RATE_CODE ? (
        <PayrollEmployeesButton onClick={onOpenHousing} ariaLabel="Сотрудники с доплатой за проживание" />
      ) : null)}
      getItemOpener={item => (item.code === HOUSING_RATE_CODE ? onOpenHousing : null)}
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
