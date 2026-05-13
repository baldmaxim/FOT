import { type FC, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MapPinIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectBucket } from '../../../types';
import { CompanyGroup } from './CompanyGroup';
import styles from './SkudPresencePage.module.css';

interface IObjectDetailsModalProps {
  bucket: IPresenceObjectBucket;
  onClose: () => void;
}

export const ObjectDetailsModal: FC<IObjectDetailsModalProps> = ({ bucket, onClose }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            <MapPinIcon className={styles.cardIcon} />
            <span>{bucket.object_name}</span>
            <span className={styles.modalBadge}>{bucket.online_count} чел.</span>
          </div>
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </header>
        <div className={styles.modalBody}>
          {bucket.companies.length === 0 ? (
            <div className={styles.cardEmpty}>Сейчас никого нет</div>
          ) : (
            bucket.companies.map(company => (
              <CompanyGroup
                key={company.company_id}
                company={company}
                isExpanded
                forceExpanded
              />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
