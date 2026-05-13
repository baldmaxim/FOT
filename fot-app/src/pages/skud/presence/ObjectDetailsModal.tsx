import { type FC, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapPinIcon } from '../../../components/ui/Icons';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import type { IPresenceObjectBucket } from '../../../types';
import { CompanyGroup } from './CompanyGroup';
import styles from './SkudPresencePage.module.css';

interface IObjectDetailsModalProps {
  bucket: IPresenceObjectBucket;
  onClose: () => void;
}

export const ObjectDetailsModal: FC<IObjectDetailsModalProps> = ({ bucket, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    // Если в bucket'е только одна компания — разворачиваем её сразу.
    bucket.companies.length === 1 ? new Set([bucket.companies[0].company_id]) : new Set(),
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const toggle = (companyId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.modalOverlay} {...overlayHandlers}>
      <div className={styles.modal}>
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
                isExpanded={expanded.has(company.company_id)}
                onToggle={() => toggle(company.company_id)}
              />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
