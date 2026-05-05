import type { FC } from 'react';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { CardReaderPanel, type CardReaderMode } from './CardReaderPanel';
import './CardReaderPanel.css';

interface ICardReaderModalProps {
  mode: CardReaderMode;
  title?: string;
  onClose: () => void;
}

export const CardReaderModal: FC<ICardReaderModalProps> = ({ mode, title, onClose }) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="scr-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="scr-modal" onClick={e => e.stopPropagation()}>
        <header className="scr-modal-head">
          <h2>{title || 'Считыватель пропусков'}</h2>
          <button type="button" className="scr-modal-close" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <div className="scr-modal-body">
          <CardReaderPanel mode={mode} embedded />
        </div>
      </div>
    </div>
  );
};
