import type { FC } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { HolderChoice } from '../../hooks/useHolderSave';
import styles from '../../pages/contractor/Contractor.module.css';

interface IHolderChangeDocsDialogProps {
  /** replace — ФИО заменено на другое; clear — ФИО стёрто. */
  mode: 'replace' | 'clear';
  prevName: string;
  nextName: string | null;
  onChoose: (choice: HolderChoice) => void;
}

/**
 * Подрядчик заменил или стёр ФИО держателя, а документы в пропуске уже заполнены:
 * это другой человек (документы прежнего очистить) или исправление опечатки (оставить).
 */
export const HolderChangeDocsDialog: FC<IHolderChangeDocsDialogProps> = ({ mode, prevName, nextName, onChoose }) => {
  const overlay = useOverlayDismiss(() => onChoose('cancel'));

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal}>
        {mode === 'replace' ? (
          <>
            <h2 className={styles.modalTitle}>ФИО изменено — это другой человек?</h2>
            <div className={styles.detailRow}>Было: {prevName}</div>
            <div className={styles.detailRow}>Стало: {nextName}</div>
          </>
        ) : (
          <>
            <h2 className={styles.modalTitle}>Стереть ФИО и документы?</h2>
            <div className={styles.detailRow}>Документы {prevName} будут очищены.</div>
          </>
        )}
        <div className={`${styles.modalActions} ${styles.holderChoiceActions}`}>
          <button type="button" className="btn-secondary" onClick={() => onChoose('cancel')}>
            Отмена
          </button>
          {mode === 'replace' ? (
            <>
              <button type="button" className="btn-secondary" onClick={() => onChoose('typo')}>
                Исправляю опечатку — оставить документы
              </button>
              <button type="button" className="btn-primary" onClick={() => onChoose('other')}>
                Другой человек — очистить документы
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={() => onChoose('clear')}>
              Стереть
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
