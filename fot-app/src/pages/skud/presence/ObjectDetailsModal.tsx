import { type FC, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import type { IPresenceObjectBucket } from '../../../types';
import { ObjectDetailView } from './ObjectDetailView';
import styles from './SkudPresencePage.module.css';

interface IObjectDetailsModalProps {
  bucket: IPresenceObjectBucket;
  onClose: () => void;
}

export const ObjectDetailsModal: FC<IObjectDetailsModalProps> = ({ bucket, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.modalOverlay} {...overlayHandlers}>
      <ObjectDetailView
        bucket={bucket}
        headerRight={(
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        )}
      />
    </div>,
    document.body,
  );
};
