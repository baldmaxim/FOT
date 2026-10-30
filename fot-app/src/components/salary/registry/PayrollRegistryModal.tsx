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
  /** Подпись стрелки «Назад» для экранного диктора: к какому окну она возвращает. */
  backLabel?: string;
  children: ReactNode;
}

/**
 * Окно таблицы поверх «Справочника» («Общежитие», «Без проезда», «Доплата», «Удержания»), поверх «Доплаты» (её списки
 * «Плановые доплаты» и «Квартира») и «Свода» (сотрудники объекта): стрелка «Назад» и ✕ закрывают только его. Через
 * портал: внутри окна с transform и overflow: hidden fixed-слой обрезался бы.
 */
export const PayrollRegistryModal: FC<IPayrollRegistryModalProps> = ({
  title, onClose, closeOnEscape, backLabel = 'Назад к справочнику', children,
}) => {
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
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label={backLabel}>
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>{title}</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          {/* data-registry-fill: таблица прокручивается внутри окна, шапка закреплена (RegistryTable.module.css). */}
          <div className={`${modal.body} ${styles.body}`} data-registry-fill>{children}</div>
        </>
      )}
    </ModalShell>,
    document.body,
  );
};
