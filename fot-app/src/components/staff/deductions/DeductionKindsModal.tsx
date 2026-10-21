import { useId, useMemo, type FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { PAYROLL_DEDUCTION_KINDS_KEY } from '../../../hooks/usePayrollDeductionKinds';
import { useStaffDeductionKinds } from '../../../hooks/useStaffDeductionKinds';
import {
  STAFF_DEDUCTION_KINDS_KEY,
  STAFF_DEDUCTIONS_KEY,
  staffDeductionService,
  type IStaffDeductionKind,
} from '../../../services/staffDeductionService';
import { PayrollDictionarySection } from '../../salary/PayrollDictionarySection';
import modal from '../../salary/PayrollModal.module.css';
import { ModalShell } from '../../ui/ModalShell';
import styles from './DeductionKindsModal.module.css';

interface IDeductionKindsModalProps {
  canEdit: boolean;
  onClose: () => void;
}

/**
 * «Виды удержаний» во вкладке «Удержания»: добавить, переименовать, удалить вид и задать сумму по умолчанию.
 * Справочник общий с «Зарплатой» («Справочник» → «Удержания»); вид, назначенный сотрудникам, сервер удалить не даст.
 */
export const DeductionKindsModal: FC<IDeductionKindsModalProps> = ({ canEdit, onClose }) => {
  const titleId = useId();
  const kinds = useStaffDeductionKinds();
  const queryClient = useQueryClient();
  const items = useMemo(
    () => kinds.data?.map(kind => ({ id: kind.id, name: kind.name, amount: kind.default_amount })),
    [kinds.data],
  );

  /**
   * Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне.
   * Название вида — и в строках удержаний, и в справочнике «Зарплаты».
   */
  const apply = async (action: () => Promise<(list: IStaffDeductionKind[]) => IStaffDeductionKind[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IStaffDeductionKind[]>(STAFF_DEDUCTION_KINDS_KEY, list => (list ? change(list) : list));
    } finally {
      void queryClient.invalidateQueries({ queryKey: STAFF_DEDUCTION_KINDS_KEY });
      void queryClient.invalidateQueries({ queryKey: STAFF_DEDUCTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: PAYROLL_DEDUCTION_KINDS_KEY });
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={modal.overlay}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Виды удержаний</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            <PayrollDictionarySection
              title="Виды удержаний"
              showTitle={false}
              items={items}
              isError={kinds.isError}
              onRetry={() => { void kinds.refetch(); }}
              nameLabel="Вид удержания"
              amountLabel="Сумма, ₽"
              addLabel="Новый вид удержания"
              canEdit={canEdit}
              deleteQuestion={name => `Удалить вид удержания «${name}»?`}
              onAdd={({ name, amount }) => apply(async () => {
                const added = await staffDeductionService.addKind({ name, default_amount: amount });
                return list => [...list, added];
              })}
              onUpdate={(id, { name, amount }) => apply(async () => {
                const updated = await staffDeductionService.updateKind(id, { name, default_amount: amount });
                return list => list.map(kind => (kind.id === id ? updated : kind));
              })}
              onDelete={id => apply(async () => {
                await staffDeductionService.removeKind(id);
                return list => list.filter(kind => kind.id !== id);
              })}
            />
          </div>
        </>
      )}
    </ModalShell>
  );
};
