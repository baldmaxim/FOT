import { useId, useState, type FC } from 'react';
import { Ban, BedDouble, CirclePlus, TimerOff, X } from 'lucide-react';

import { useAuth } from '../../contexts/AuthContext';
import { ModalShell } from '../ui/ModalShell';
import { DeductionKindsEditor } from './DeductionKindsEditor';
import { PayrollRatesEditor } from './PayrollRatesEditor';
import { PayrollSectionAccessList } from './PayrollSectionAccessList';
import { CompensationStopRegistry } from './registry/CompensationStopRegistry';
import { DeductionRegistry } from './registry/DeductionRegistry';
import { DormitoryRegistry } from './registry/DormitoryRegistry';
import { OvertimeStopRegistry } from './registry/OvertimeStopRegistry';
import { SupplementRegistry } from './registry/SupplementRegistry';
import modal from './PayrollModal.module.css';
import styles from './PayrollDictionary.module.css';

interface IPayrollDictionaryModalProps {
  onClose: () => void;
}

/** Окно таблицы поверх «Справочника»; открыто одно. */
type RegistryWindow = 'dormitory' | 'stops' | 'supplements' | 'overtime' | 'deductions';

/**
 * Окно «Справочник» на «Расчётах»: виды удержаний, ставки и кому доступен раздел. Каждая правка
 * сохраняется сразу — общей кнопки «Сохранить» нет. Без права правки списки только показываются;
 * «Доступ к разделу» — всегда только просмотр. В шапке — «Общежитие» (кто живёт и кому доплата за общежитие),
 * «Без проезда», «Доплата» (в ней — списки «Плановые доплаты» и «Квартира»), «Без переработки»; у заголовка
 * «Удержания» — «Сотрудники», своя таблица окном поверх.
 */
export const PayrollDictionaryModal: FC<IPayrollDictionaryModalProps> = ({ onClose }) => {
  const titleId = useId();
  const { canEditPage } = useAuth();
  // Справочники, «Без проезда» и «Без переработки» — те же ключи, что у сервера (payroll.routes: deductionsEdit).
  const canEdit = canEditPage('/salary/terms') || canEditPage('/salary/payments');
  // Проживание, доплаты и сумма удержания — это условия оплаты (termsEdit).
  const canEditTerms = canEditPage('/salary/terms');
  // Открыто окно таблицы — Escape закрывает его, а не «Справочник».
  const [opened, setOpened] = useState<RegistryWindow | null>(null);
  const close = () => setOpened(null);

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={modal.overlay}
      containerClassName={styles.container}
      closeOnEscape={opened === null}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={`${modal.header} ${styles.header}`}>
            <div className={`${modal.headerText} ${styles.headerTitle}`}>
              <h2 id={titleId} className={modal.title}>Справочник</h2>
            </div>
            <div className={styles.headerActions}>
              <button type="button" className={styles.headerButton} onClick={() => setOpened('dormitory')}>
                <BedDouble size={16} aria-hidden="true" />
                <span>Общежитие</span>
              </button>
              <button type="button" className={styles.headerButton} onClick={() => setOpened('stops')}>
                <Ban size={16} aria-hidden="true" />
                <span>Без проезда</span>
              </button>
              <button type="button" className={styles.headerButton} onClick={() => setOpened('supplements')}>
                <CirclePlus size={16} aria-hidden="true" />
                <span>Доплата</span>
              </button>
              <button type="button" className={styles.headerButton} onClick={() => setOpened('overtime')}>
                <TimerOff size={16} aria-hidden="true" />
                <span>Без переработки</span>
              </button>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={`${modal.body} ${styles.columns}`}>
            <DeductionKindsEditor canEdit={canEdit} onOpenList={() => setOpened('deductions')} />
            <PayrollRatesEditor canEdit={canEdit} />
            <PayrollSectionAccessList />
          </div>

          {opened === 'dormitory' && <DormitoryRegistry canEdit={canEdit} onClose={close} />}
          {opened === 'stops' && <CompensationStopRegistry canEdit={canEdit} onClose={close} />}
          {opened === 'supplements' && <SupplementRegistry canEdit={canEditTerms} onClose={close} />}
          {opened === 'overtime' && <OvertimeStopRegistry canEdit={canEdit} onClose={close} />}
          {opened === 'deductions' && <DeductionRegistry canEdit={canEditTerms} onClose={close} />}
        </>
      )}
    </ModalShell>
  );
};
