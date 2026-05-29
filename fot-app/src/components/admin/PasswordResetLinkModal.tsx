import { type FC, useEffect, useRef, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { useToast } from '../../contexts/ToastContext';
import styles from './PasswordResetLinkModal.module.css';

interface IProps {
  resetUrl: string;
  expiresAt: string;
  userLabel?: string;
  onClose: () => void;
}

export const PasswordResetLinkModal: FC<IProps> = ({ resetUrl, expiresAt, userLabel, onClose }) => {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resetUrl);
      setCopied(true);
      toast.success('Ссылка скопирована');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      inputRef.current?.select();
      toast.error('Не удалось скопировать. Выделите вручную и Ctrl+C.');
    }
  };

  const expiresLabel = (() => {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) return expiresAt;
    return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  })();

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              Ссылка для сброса пароля{userLabel ? ` — ${userLabel}` : ''}
            </span>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className={styles.body}>
            <div className={styles.hint}>
              Передайте эту ссылку пользователю (Telegram, звонок, лично). По ней он сам задаст новый пароль — вы пароль не увидите.
              Ссылка действует 1 час и одноразовая: при повторной генерации предыдущая перестанет работать.
            </div>
            <div className={styles.urlRow}>
              <input
                ref={inputRef}
                type="text"
                readOnly
                value={resetUrl}
                className={styles.urlInput}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className={styles.copyBtn} onClick={handleCopy} disabled={copied}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>
            <div className={styles.expires}>Истекает: {expiresLabel}</div>
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.closeBtnPrimary} onClick={requestClose}>
              Закрыть
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
