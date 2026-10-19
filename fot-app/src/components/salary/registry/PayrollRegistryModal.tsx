import { useId, type FC, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, X } from 'lucide-react';

import { ModalShell } from '../../ui/ModalShell';
import modal from '../PayrollModal.module.css';
import styles from './PayrollRegistryModal.module.css';

interface IPayrollRegistryModalProps {
  title: string;
  onClose: () => void;
  /**
   * Escape закрывает только верхний слой: пока открыт фильтр столбца или окно формы, это окно по
   * Escape не закрывается.
   */
  closeOnEscape: boolean;
  children: ReactNode;
}

/**
 * Окно таблицы поверх «Справочника» («Общежитие», «Доплата за проживание», «Не выплачивать», «Доплата»,
 * «Удержания»): стрелка «Назад» и ✕ закрывают только его. Через портал: внутри окна с transform и
 * overflow: hidden fixed-слой обрезался бы.
 */
export const PayrollRegistryModal: FC<IPayrollRegistryModalProps> = ({ title, onClose, closeOnEscape, children }) => {
  const titleId = useId();

  return createPortal(
    <ModalShell
      onClose={onClose}
      overlayClassName={`${modal.overlay} ${styles.overlay}`}
      containerClassName={styles.container}
      closeOnEscape={closeOnEscape}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={`${modal.header} ${styles.header}`}>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Назад к справочнику">
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>{title}</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>{children}</div>
        </>
      )}
    </ModalShell>,
    document.body,
  );
};
