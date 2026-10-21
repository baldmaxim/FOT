import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PAYROLL_DEDUCTION_KINDS_KEY, usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { payrollService } from '../../services/payrollService';
import type { IStaffDeductionKind } from '../../services/staffDeductionService';
import { invalidateDeductionQueries } from '../../utils/deductionQueries';
import { DeductionSubkindsSection } from './DeductionSubkindsSection';
import { PayrollDictionarySection } from './PayrollDictionarySection';

interface IDeductionKindsEditorProps {
  canEdit: boolean;
  /** «Сотрудники» у заголовка: таблица сотрудников с удержаниями. */
  onOpenList: () => void;
}

/**
 * «Удержания» в окне «Справочник»: виды удержаний — добавить, переименовать, удалить; «+» у вида раскрывает его
 * подвиды (миграция 321). Справочник общий с кадрами («Управление кадрами» → «Удержания» → «Виды удержаний»); вид
 * и подвид, назначенные сотрудникам, сервер удалить не даст. Кнопка «Сотрудники» у заголовка открывает таблицу
 * удержаний сотрудников — те же записи, что во вкладке кадров.
 */
export const DeductionKindsEditor: FC<IDeductionKindsEditorProps> = ({ canEdit, onOpenList }) => {
  const kinds = usePayrollDeductionKinds();
  const queryClient = useQueryClient();

  /**
   * Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне.
   * Название вида — и в таблице удержаний, и у кадров.
   */
  const apply = async (action: () => Promise<(list: IStaffDeductionKind[]) => IStaffDeductionKind[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IStaffDeductionKind[]>(PAYROLL_DEDUCTION_KINDS_KEY, list => (list ? change(list) : list));
    } finally {
      void invalidateDeductionQueries(queryClient);
    }
  };

  return (
    <PayrollDictionarySection
      title="Удержания"
      lists={[{ label: 'Сотрудники', ariaLabel: 'Сотрудники с удержаниями', onOpen: onOpenList }]}
      items={kinds.data}
      isError={kinds.isError}
      onRetry={() => { void kinds.refetch(); }}
      nameLabel="Вид удержания"
      addLabel="Новый вид удержания"
      canEdit={canEdit}
      deleteQuestion={name => `Удалить вид удержания «${name}»?`}
      renderDetails={item => {
        const kind = kinds.data?.find(entry => entry.id === item.id);
        return kind && (
          <DeductionSubkindsSection
            kind={kind}
            canEdit={canEdit}
            kindsKey={PAYROLL_DEDUCTION_KINDS_KEY}
            api={payrollService.deductionSubkinds}
          />
        );
      }}
      detailsLabel={name => `Подвиды: ${name}`}
      onAdd={({ name }) => apply(async () => {
        const added = await payrollService.addDeductionKind(name);
        return list => [...list, { ...added, default_amount: null, subkinds: [] }];
      })}
      onUpdate={(id, { name }) => apply(async () => {
        const renamed = await payrollService.renameDeductionKind(id, name);
        return list => list.map(kind => (kind.id === id ? { ...kind, name: renamed.name } : kind));
      })}
      onDelete={id => apply(async () => {
        await payrollService.deleteDeductionKind(id);
        return list => list.filter(kind => kind.id !== id);
      })}
    />
  );
};
