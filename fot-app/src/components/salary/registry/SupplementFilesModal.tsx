import { useId, type FC } from 'react';
import { X } from 'lucide-react';

import type { IPayrollSupplementFile } from '../../../services/payrollRegistryService';
import { ModalShell } from '../../ui/ModalShell';
import formStyles from '../../ui/registry/RegistryFormModal.module.css';
import { SupplementFileList } from './SupplementFileList';

interface ISupplementFilesModalProps {
  fullName: string;
  files: readonly IPayrollSupplementFile[];
  onOpen: (file: IPayrollSupplementFile) => void;
  /** false — поверх открыт просмотр файла: Escape закрывает только его. */
  closeOnEscape: boolean;
  onClose: () => void;
}

/** Файлы разовой доплаты из таблицы «Доплата за месяц» (если их несколько): только открыть. */
export const SupplementFilesModal: FC<ISupplementFilesModalProps> = ({ fullName, files, onOpen, closeOnEscape, onClose }) => {
  const titleId = useId();
  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={`${formStyles.overlay} ${formStyles.overlayRaised}`}
      containerClassName={formStyles.container}
      closeOnEscape={closeOnEscape}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={formStyles.header}>
            <h2 id={titleId} className={formStyles.title}>Файлы: {fullName}</h2>
            <button type="button" className={formStyles.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <div className={formStyles.body}>
            <SupplementFileList
              items={files.map(file => ({
                key: String(file.id),
                name: file.file_name,
                size: file.file_size,
                onOpen: () => onOpen(file),
              }))}
            />
          </div>
        </>
      )}
    </ModalShell>
  );
};
