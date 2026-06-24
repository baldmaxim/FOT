import { useState, type FC } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { IPassDocDuplicate, IPassDocuments } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

/** Маска номера патента: «77 №2600295204» (2 цифры серии + 10 цифр номера). */
export const formatPatentNumber = (raw: string): string => {
  const digits = raw.replace(/\D/g, '').slice(0, 12);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)} №${digits.slice(2)}`;
};

interface IDuplicates {
  patent?: IPassDocDuplicate[];
  passport?: IPassDocDuplicate[];
}

/** Есть ли у строки дубль паспорта/патента (для красного креста на кнопке). */
export const hasDocDuplicate = (r: { dup_patent?: unknown[]; dup_passport?: unknown[] }): boolean =>
  (r.dup_patent?.length ?? 0) > 0 || (r.dup_passport?.length ?? 0) > 0;

interface IProps {
  documents: IPassDocuments;
  holderName: string | null;
  passNumber: string;
  /** Только просмотр (админ / согласованный пропуск). */
  readOnly?: boolean;
  busy?: boolean;
  /** Совпадения номеров с другими держателями (для подсветки). */
  duplicates?: IDuplicates;
  onClose: () => void;
  onSave?: (docs: IPassDocuments) => void;
}

const dupNote = (rows: IPassDocDuplicate[] | undefined): string | null => {
  if (!rows || rows.length === 0) return null;
  const names = rows
    .map(r => `${r.holder_name?.trim() || 'без ФИО'} (№${r.pass_number})`)
    .join(', ');
  return `Совпадает с: ${names}`;
};

export const PassDocumentsModal: FC<IProps> = ({
  documents,
  holderName,
  passNumber,
  readOnly = false,
  busy = false,
  duplicates,
  onClose,
  onSave,
}) => {
  const overlay = useOverlayDismiss(onClose);
  const [form, setForm] = useState({
    passport_series_number: documents.passport_series_number ?? '',
    passport_issue_date: (documents.passport_issue_date ?? '').slice(0, 10),
    birth_date: (documents.birth_date ?? '').slice(0, 10),
    patent_number: documents.patent_number ?? '',
    patent_issue_date: (documents.patent_issue_date ?? '').slice(0, 10),
    patent_blank_number: documents.patent_blank_number ?? '',
  });

  const passportDup = dupNote(duplicates?.passport);
  const patentDup = dupNote(duplicates?.patent);

  const passportCls = `${styles.input} ${styles.fullInput} ${passportDup ? styles.docDupInput : ''}`;
  const patentCls = `${styles.input} ${styles.fullInput} ${patentDup ? styles.docDupInput : ''}`;

  const handleSave = () => {
    onSave?.({
      passport_series_number: form.passport_series_number.trim() || null,
      passport_issue_date: form.passport_issue_date || null,
      birth_date: form.birth_date || null,
      patent_number: form.patent_number.trim() || null,
      patent_issue_date: form.patent_issue_date || null,
      patent_blank_number: form.patent_blank_number.trim() || null,
    });
  };

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
        <h2 className={styles.modalTitle}>
          Документы — {holderName ?? `пропуск № ${passNumber}`}
        </h2>

        <div className={styles.field}>
          <span className={styles.label}>Паспорт серия номер</span>
          <input
            className={passportCls}
            value={form.passport_series_number}
            autoFocus={!readOnly}
            disabled={readOnly}
            placeholder="Серия и номер"
            onChange={e => setForm(prev => ({ ...prev, passport_series_number: e.target.value }))}
          />
          {passportDup && <span className={styles.docDupNote}>{passportDup}</span>}
        </div>

        <div className={styles.docRow}>
          <div className={styles.field}>
            <span className={styles.label}>Дата выдачи документа, удостоверяющего личность</span>
            <input
              className={`${styles.input} ${styles.numInput}`}
              type="date"
              value={form.passport_issue_date}
              disabled={readOnly}
              onChange={e => setForm(prev => ({ ...prev, passport_issue_date: e.target.value }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Дата рождения</span>
            <input
              className={`${styles.input} ${styles.numInput}`}
              type="date"
              value={form.birth_date}
              disabled={readOnly}
              onChange={e => setForm(prev => ({ ...prev, birth_date: e.target.value }))}
            />
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Номер патента</span>
          <input
            className={patentCls}
            value={form.patent_number}
            inputMode="numeric"
            disabled={readOnly}
            placeholder="77 №2600295204"
            onChange={e => setForm(prev => ({ ...prev, patent_number: formatPatentNumber(e.target.value) }))}
          />
          {patentDup && <span className={styles.docDupNote}>{patentDup}</span>}
        </div>

        <div className={styles.docRow}>
          <div className={styles.field}>
            <span className={styles.label}>Дата выдачи патента</span>
            <input
              className={`${styles.input} ${styles.numInput}`}
              type="date"
              value={form.patent_issue_date}
              disabled={readOnly}
              onChange={e => setForm(prev => ({ ...prev, patent_issue_date: e.target.value }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Номер бланка</span>
            <input
              className={`${styles.input} ${styles.fullInput}`}
              value={form.patent_blank_number}
              disabled={readOnly}
              placeholder="Например: ПР8048893"
              onChange={e => setForm(prev => ({ ...prev, patent_blank_number: e.target.value }))}
            />
          </div>
        </div>

        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {readOnly ? 'Закрыть' : 'Отмена'}
          </button>
          {!readOnly && (
            <button className="btn-primary" onClick={handleSave} disabled={busy}>
              Сохранить
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PassDocumentsModal;
