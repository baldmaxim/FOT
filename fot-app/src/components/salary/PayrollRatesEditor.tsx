import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PAYROLL_RATES_KEY, usePayrollRates } from '../../hooks/usePayrollRates';
import { payrollService, type IPayrollRate } from '../../services/payrollService';
import { PayrollDictionarySection } from './PayrollDictionarySection';

interface IPayrollRatesEditorProps {
  canEdit: boolean;
}

/**
 * «Ставки» в окне «Справочник»: название и значение — добавить, изменить, удалить.
 * Ставка только хранится: в окно сотрудника и в расчёты не подставляется.
 */
export const PayrollRatesEditor: FC<IPayrollRatesEditorProps> = ({ canEdit }) => {
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
      addLabel="Новая ставка"
      canEdit={canEdit}
      deleteQuestion={name => `Удалить ставку «${name}»?`}
      onAdd={payload => apply(async () => {
        const added = await payrollService.addRate(payload);
        return list => [...list, added];
      })}
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
