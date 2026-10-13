import { useId, type FC } from 'react';
import { X } from 'lucide-react';

import { useAuth } from '../../contexts/AuthContext';
import { ModalShell } from '../ui/ModalShell';
import { DeductionKindsEditor } from './DeductionKindsEditor';
import { PayrollRatesEditor } from './PayrollRatesEditor';
import modal from './PayrollModal.module.css';
import styles from './PayrollDictionary.module.css';

interface IPayrollDictionaryModalProps {
  onClose: () => void;
}

/**
 * Окно «Справочник» на «Расчётах»: виды удержаний и ставки. Каждая правка сохраняется сразу —
 * общей кнопки «Сохранить» нет. Без права правки списки только показываются.
 */
export const PayrollDictionaryModal: FC<IPayrollDictionaryModalProps> = ({ onClose }) => {
  const titleId = useId();
  const { canEditPage } = useAuth();
  // Те же ключи, что у сервера (payroll.routes: deductionsEdit).
  const canEdit = canEditPage('/salary/terms') || canEditPage('/salary/payments');

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
              <h2 id={titleId} className={modal.title}>Справочник</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={`${modal.body} ${styles.columns}`}>
            <DeductionKindsEditor canEdit={canEdit} />
            <PayrollRatesEditor canEdit={canEdit} />
          </div>
        </>
      )}
    </ModalShell>
  );
};
