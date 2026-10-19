import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PAYROLL_DEDUCTION_KINDS_KEY, usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { payrollService, type IPayrollDeductionKind } from '../../services/payrollService';
import { PayrollDictionarySection } from './PayrollDictionarySection';

interface IDeductionKindsEditorProps {
  canEdit: boolean;
  /** Заголовок и 👥: таблица сотрудников с удержаниями. */
  onOpenList: () => void;
}

/**
 * «Удержания» в окне «Справочник»: виды удержаний — добавить, переименовать, удалить.
 * Тот же справочник — список «Вид» в окне сотрудника; вид, отмеченный у сотрудников, сервер удалить не даст.
 * Заголовок открывает таблицу сотрудников с удержаниями.
 */
export const DeductionKindsEditor: FC<IDeductionKindsEditorProps> = ({ canEdit, onOpenList }) => {
  const kinds = usePayrollDeductionKinds();
  const queryClient = useQueryClient();

  /** Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне. */
  const apply = async (action: () => Promise<(list: IPayrollDeductionKind[]) => IPayrollDeductionKind[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IPayrollDeductionKind[]>(PAYROLL_DEDUCTION_KINDS_KEY, list => (list ? change(list) : list));
    } finally {
      void queryClient.invalidateQueries({ queryKey: PAYROLL_DEDUCTION_KINDS_KEY });
    }
  };

  return (
    <PayrollDictionarySection
      title="Удержания"
      onOpenList={onOpenList}
      listLabel="Сотрудники с удержаниями"
      items={kinds.data}
      isError={kinds.isError}
      onRetry={() => { void kinds.refetch(); }}
      nameLabel="Вид удержания"
      addLabel="Новый вид удержания"
      canEdit={canEdit}
      deleteQuestion={name => `Удалить вид удержания «${name}»?`}
      onAdd={({ name }) => apply(async () => {
        const added = await payrollService.addDeductionKind(name);
        return list => [...list, added];
      })}
      onUpdate={(id, { name }) => apply(async () => {
        const renamed = await payrollService.renameDeductionKind(id, name);
        return list => list.map(kind => (kind.id === id ? renamed : kind));
      })}
      onDelete={id => apply(async () => {
        await payrollService.deleteDeductionKind(id);
        return list => list.filter(kind => kind.id !== id);
      })}
    />
  );
};
