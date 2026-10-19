import { useId, type FC, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { ModalShell } from '../ModalShell';
import styles from './RegistryFormModal.module.css';

interface IRegistryFormModalProps {
  title: string;
  onClose: () => void;
  /** Отправка формы; requestClose — закрыть окно с анимацией после успешного сохранения. */
  onSubmit: (requestClose: () => void) => void;
  saving: boolean;
  /** Ошибка проверки или сервера — под полями, ввод не теряется. */
  error: string | null;
  /** id абзаца ошибки — для aria-describedby полей. */
  errorId?: string;
  /** Поверх окна таблицы «Справочника» и фильтра столбца. */
  raised?: boolean;
  /** «Сохранить» неактивна (например, выбран сотрудник без оклада). */
  submitDisabled?: boolean;
  children: ReactNode;
}

/**
 * Окно формы таблицы-реестра: «Добавить сотрудника» / ✎ — заголовок с крестиком, поля, ошибка, «Отмена» и
 * «Сохранить». Пока идёт сохранение, окно не закрывается и кнопки неактивны (без двойной записи).
 * Поля внутри — на классах того же RegistryFormModal.module.css (field, label, dateInput, select…).
 */
export const RegistryFormModal: FC<IRegistryFormModalProps> = ({
  title, onClose, onSubmit, saving, error, errorId, raised = false, submitDisabled = false, children,
}) => {
  const titleId = useId();

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={raised ? `${styles.overlay} ${styles.overlayRaised}` : styles.overlay}
      containerClassName={styles.container}
      closeOnEscape={!saving}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form
          className={styles.form}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!saving) onSubmit(requestClose);
          }}
          noValidate
        >
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            <button type="button" className={styles.closeButton} onClick={requestClose} disabled={saving} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.body}>
            {children}
            {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
          </div>

          <footer className={styles.footer}>
            <button type="button" className={styles.secondaryButton} onClick={requestClose} disabled={saving}>
              Отмена
            </button>
            <button type="submit" className={styles.primaryButton} disabled={saving || submitDisabled}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </footer>
        </form>
      )}
    </ModalShell>
  );
};
