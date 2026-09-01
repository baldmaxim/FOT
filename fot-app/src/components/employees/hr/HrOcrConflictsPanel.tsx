import { useState, type FC } from 'react';
import { Check, X } from 'lucide-react';
import { hrProfileService } from '../../../services/hrProfileService';
import { useToast } from '../../../contexts/ToastContext';
import type { IHrOcrConflict } from '../../../types/hrProfile';
import styles from './HrProfileModal.module.css';

interface IHrOcrConflictsPanelProps {
  conflicts: IHrOcrConflict[];
  canEdit: boolean;
  onResolved: () => void;
}

/** Расхождения OCR ↔ карточка: «Применить» (взять из документа) / «Отклонить» (оставить как есть). */
export const HrOcrConflictsPanel: FC<IHrOcrConflictsPanelProps> = ({ conflicts, canEdit, onResolved }) => {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  if (conflicts.length === 0) return null;

  const act = async (c: IHrOcrConflict, apply: boolean) => {
    setBusy(c.id);
    try {
      if (apply) await hrProfileService.applyConflict(c.id);
      else await hrProfileService.dismissConflict(c.id);
      toast.success(apply ? `${c.field_label}: применено значение из документа` : `${c.field_label}: оставлено текущее значение`);
      onResolved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось обработать расхождение');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.conflicts}>
      <h4>Расхождения с документами <span className={styles.conflictCount}>{conflicts.length}</span></h4>
      {conflicts.map(c => (
        <div key={c.id} className={styles.conflictRow}>
          <div className={styles.conflictField}>
            <b>{c.field_label}</b>
            {c.document_type && <span className={styles.muted}> · {c.document_type}</span>}
          </div>
          <div className={styles.conflictValues}>
            <span><span className={styles.muted}>В карточке:</span> {c.current_value ?? '—'}</span>
            <span><span className={styles.muted}>В документе:</span> {c.ocr_value ?? '—'}</span>
          </div>
          {canEdit && (
            <div className={styles.conflictActions}>
              <button type="button" className={`${styles.smallBtn} ${styles.smallBtnOk}`} disabled={busy === c.id} onClick={() => void act(c, true)}><Check size={13} /> Применить</button>
              <button type="button" className={styles.smallBtn} disabled={busy === c.id} onClick={() => void act(c, false)}><X size={13} /> Отклонить</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
