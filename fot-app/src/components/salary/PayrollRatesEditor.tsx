import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BedDouble } from 'lucide-react';

import { PAYROLL_RATES_KEY, usePayrollRates } from '../../hooks/usePayrollRates';
import { DORMITORY_RATE_CODE, payrollService, type IPayrollRate } from '../../services/payrollService';
import { PayrollDictionarySection } from './PayrollDictionarySection';
import styles from './PayrollDictionary.module.css';

interface IPayrollRatesEditorProps {
  canEdit: boolean;
  /** Кнопка у «Проживания общежития»: окно с теми, кто живёт в общежитии. */
  onOpenDormitory: () => void;
}

/**
 * «Ставки» в окне «Справочник»: значение ставки — изменить. Новых ставок здесь не заводят (миграция 313);
 * у ставки с кодом название не меняется и удалить её нельзя. Ставка только хранится: в окно сотрудника
 * и в расчёты не подставляется.
 */
export const PayrollRatesEditor: FC<IPayrollRatesEditorProps> = ({ canEdit, onOpenDormitory }) => {
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
      renderExtraAction={item => (item.code === DORMITORY_RATE_CODE ? (
        <button
          type="button"
          className={styles.iconButton}
          onClick={onOpenDormitory}
          title="Проживающие в общежитии"
          aria-label="Проживающие в общежитии"
        >
          <BedDouble size={16} aria-hidden="true" />
        </button>
      ) : null)}
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
