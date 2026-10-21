import { useMemo, type FC } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

import type {
  IDeductionSubkind,
  IDeductionSubkindsApi,
  IStaffDeductionKind,
} from '../../services/staffDeductionService';
import { invalidateDeductionQueries, withSubkinds } from '../../utils/deductionQueries';
import { PayrollDictionarySection } from './PayrollDictionarySection';

interface IDeductionSubkindsSectionProps {
  kind: IStaffDeductionKind;
  canEdit: boolean;
  /** Справочник окна (кадров или «Зарплаты»): ответ сервера сразу попадает в него. */
  kindsKey: QueryKey;
  /** API своего раздела: у кадров и «Зарплаты» свои права, справочник один. */
  api: IDeductionSubkindsApi;
}

/**
 * Подвиды вида под его строкой в «Видах удержаний» кадров и в «Справочнике» «Зарплаты» (миграция 321): название
 * и сумма по умолчанию, добавить, изменить, удалить. Подвид, назначенный сотрудникам, сервер удалить не даст.
 */
export const DeductionSubkindsSection: FC<IDeductionSubkindsSectionProps> = ({ kind, canEdit, kindsKey, api }) => {
  const queryClient = useQueryClient();
  const items = useMemo(
    () => kind.subkinds.map(subkind => ({ id: subkind.id, name: subkind.name, amount: subkind.default_amount })),
    [kind.subkinds],
  );

  /** Ответ сервера сразу в списке; перечитывание — и после отказа: подвид могли изменить в другом разделе. */
  const apply = async (action: () => Promise<(subkinds: IDeductionSubkind[]) => IDeductionSubkind[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IStaffDeductionKind[]>(kindsKey, list => (list ? withSubkinds(list, kind.id, change) : list));
    } finally {
      void invalidateDeductionQueries(queryClient);
    }
  };

  return (
    <PayrollDictionarySection
      title={`Подвиды: ${kind.name}`}
      showTitle={false}
      items={items}
      isError={false}
      onRetry={() => undefined}
      nameLabel="Подвид"
      amountLabel="Сумма, ₽"
      addLabel="Новый подвид"
      emptyText="Подвидов нет"
      canEdit={canEdit}
      deleteQuestion={name => `Удалить подвид «${name}» («${kind.name}»)?`}
      onAdd={({ name, amount }) => apply(async () => {
        const added = await api.add(kind.id, { name, default_amount: amount });
        return subkinds => [...subkinds, added];
      })}
      onUpdate={(id, { name, amount }) => apply(async () => {
        const updated = await api.update(id, { name, default_amount: amount });
        return subkinds => subkinds.map(subkind => (subkind.id === id ? updated : subkind));
      })}
      onDelete={id => apply(async () => {
        await api.remove(id);
        return subkinds => subkinds.filter(subkind => subkind.id !== id);
      })}
    />
  );
};
