import { type CSSProperties, type FC, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { PresenceState } from '../../hooks/useAnimatedPresence';
import { cx, readCssMs } from '../../utils/motion';
import styles from './ModalShell.module.css';

export interface IModalShellApi {
  /** Закрыть с exit-анимацией: проигрывает закрытие, затем вызывает onClose. */
  requestClose: () => void;
}

interface IModalShellProps {
  /** Реальное размонтирование (родитель перестаёт рендерить модалку). */
  onClose: () => void;
  /** Класс backdrop-оверлея модалки (позиционирование/фон/z-index). */
  overlayClassName?: string;
  /** Класс контейнера модалки (размеры/фон/радиус). */
  containerClassName?: string;
  /** Inline-стиль оверлея (для модалок без CSS-класса оверлея). */
  overlayStyle?: CSSProperties;
  /** Inline-стиль контейнера (для модалок без CSS-класса контейнера). */
  containerStyle?: CSSProperties;
  /** Закрывать по Escape. По умолчанию true. */
  closeOnEscape?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  children: ReactNode | ((api: IModalShellApi) => ReactNode);
}

/**
 * Тонкая обёртка анимации модалки (transitions.dev «Modal open / close»).
 * Добавляет enter/exit scale+fade поверх существующей разметки модалки, не
 * меняя её вид: классы оверлея/контейнера передаются пропсами и композятся
 * с анимационными классами. Закрытие через requestClose проигрывает выход
 * и только затем вызывает onClose (родитель размонтирует).
 */
export const ModalShell: FC<IModalShellProps> = ({
  onClose,
  overlayClassName,
  containerClassName,
  overlayStyle,
  containerStyle,
  closeOnEscape = true,
  children,
  ...aria
}) => {
  const [phase, setPhase] = useState<PresenceState>('entering');

  // Вход: после первого кадра переключаемся на 'open' → запускается переход.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  const requestClose = useCallback(() => setPhase('closing'), []);

  // Выход: проигрываем закрытие, затем зовём onClose (родитель размонтирует).
  useEffect(() => {
    if (phase !== 'closing') return;
    const ms = readCssMs('--modal-close-dur', 150);
    const timer = window.setTimeout(onClose, ms);
    return () => clearTimeout(timer);
  }, [phase, onClose]);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnEscape, requestClose]);

  const overlayHandlers = useOverlayDismiss(requestClose);

  return (
    <div
      className={cx(styles.overlay, overlayClassName)}
      style={overlayStyle}
      data-state={phase}
      {...overlayHandlers}
    >
      <div
        className={cx(styles.modal, containerClassName)}
        style={containerStyle}
        data-state={phase}
        role="dialog"
        aria-modal="true"
        aria-label={aria['aria-label']}
        aria-labelledby={aria['aria-labelledby']}
      >
        {typeof children === 'function' ? children({ requestClose }) : children}
      </div>
    </div>
  );
};
