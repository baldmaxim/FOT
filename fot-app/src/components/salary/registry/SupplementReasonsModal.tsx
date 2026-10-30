import { useId, useMemo, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { useSupplementReasons } from '../../../hooks/useSupplementReasons';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IPayrollSupplementReason,
} from '../../../services/payrollRegistryService';
import { sortSupplementReasons } from '../../../utils/payrollRegistryForms';
import { PayrollDictionarySection } from '../PayrollDictionarySection';
import modal from '../PayrollModal.module.css';
import { ModalShell } from '../../ui/ModalShell';
import styles from './SupplementReasonsModal.module.css';

interface ISupplementReasonsModalProps {
  onClose: () => void;
  /** Переименовали основание — форма меняет выбранное (сервер сменил его и у доплат). */
  onRenamed: (from: string, to: string) => void;
  /** Удалили основание из списка — форма сбрасывает выбор, если это не основание самой доплаты. */
  onDeleted: (name: string) => void;
}

/**
 * Окно «Основания доплаты» поверх формы «Разовая доплата»: добавить, переименовать, удалить основание (миграция 340).
 * Порталом в body и соседом формы, а не внутри неё: у списка свои <form>, их submit не должен сохранять доплату.
 * Переименование меняет основание и у внесённых разовых доплат; удаление — только строку списка.
 */
export const SupplementReasonsModal: FC<ISupplementReasonsModalProps> = ({ onClose, onRenamed, onDeleted }) => {
  const titleId = useId();
  const reasons = useSupplementReasons();
  const queryClient = useQueryClient();
  const items = useMemo(() => reasons.data && sortSupplementReasons(reasons.data), [reasons.data]);
  const nameOf = (id: number): string | undefined => reasons.data?.find(reason => reason.id === id)?.name;

  /**
   * Ответ сервера сразу в списке; перечитывание — и после отказа: запись могли изменить в другом окне.
   * Префикс перечитывает и таблицу «Доплата» — там новое название основания.
   */
  const apply = async (action: () => Promise<(list: IPayrollSupplementReason[]) => IPayrollSupplementReason[]>) => {
    try {
      const change = await action();
      queryClient.setQueryData<IPayrollSupplementReason[]>(
        PAYROLL_REGISTRY_KEYS.supplementReasons,
        list => (list ? change(list) : list),
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });
    }
  };

  return createPortal(
    <ModalShell
      onClose={onClose}
      overlayClassName={`${modal.overlay} ${styles.overlay}`}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={`${modal.header} ${styles.header}`}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Основания доплаты</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            <PayrollDictionarySection
              title="Основания доплаты"
              showTitle={false}
              items={items}
              isError={reasons.isError}
              onRetry={() => { void reasons.refetch(); }}
              nameLabel="Основание"
              addLabel="Новое основание"
              canEdit
              deleteQuestion={name => `Удалить основание «${name}» из списка? У внесённых доплат оно останется.`}
              onAdd={({ name }) => apply(async () => {
                const added = await payrollRegistryService.addSupplementReason(name);
                return list => [...list, added];
              })}
              onUpdate={(id, { name }) => apply(async () => {
                const previous = nameOf(id);
                const renamed = await payrollRegistryService.renameSupplementReason(id, name);
                if (previous !== undefined) onRenamed(previous, renamed.name);
                return list => list.map(reason => (reason.id === id ? renamed : reason));
              })}
              onDelete={id => apply(async () => {
                const removed = nameOf(id);
                await payrollRegistryService.removeSupplementReason(id);
                if (removed !== undefined) onDeleted(removed);
                return list => list.filter(reason => reason.id !== id);
              })}
            />
          </div>
        </>
      )}
    </ModalShell>,
    document.body,
  );
};
