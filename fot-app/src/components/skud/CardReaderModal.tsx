import type { FC } from 'react';
import { X } from 'lucide-react';
import { CardReaderPanel, type CardReaderMode } from './CardReaderPanel';
import { ModalShell } from '../ui/ModalShell';
import './CardReaderPanel.css';

interface ICardReaderModalProps {
  mode: CardReaderMode;
  title?: string;
  onClose: () => void;
}

export const CardReaderModal: FC<ICardReaderModalProps> = ({ mode, title, onClose }) => {
  return (
    <ModalShell onClose={onClose} overlayClassName="scr-modal-overlay" containerClassName="scr-modal">
      {({ requestClose }) => (
        <>
          <header className="scr-modal-head">
            <h2>{title || 'Считыватель пропусков'}</h2>
            <button type="button" className="scr-modal-close" onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </header>
          <div className="scr-modal-body">
            <CardReaderPanel mode={mode} embedded />
          </div>
        </>
      )}
    </ModalShell>
  );
};
