import type { FC, KeyboardEvent, PointerEvent } from 'react';

import styles from './ColumnResizeHandle.module.css';

/** Обработчики ручки ширины; header — заголовок столбца, у которого ручка (null — не нашёлся). */
export interface IColumnResize {
  onPointerDown: (event: PointerEvent<HTMLSpanElement>) => void;
  onAutoFit: (header: HTMLTableCellElement | null) => void;
  onStep: (delta: -1 | 1, header: HTMLTableCellElement | null) => void;
}

interface IColumnResizeHandleProps {
  /** Подпись столбца — для экранного диктора. */
  label: string;
  resize: IColumnResize;
}

const headerOf = (element: HTMLElement): HTMLTableCellElement | null => element.closest('th');

/**
 * Ручка ширины у правого края заголовка, как в Excel («Проживание», «Расчёты»): тянуть мышью, двойной клик — по самому
 * длинному тексту; с клавиатуры — ← / → (шаг) и Enter (по тексту). th должен быть позиционирован (relative или sticky).
 */
export const ColumnResizeHandle: FC<IColumnResizeHandleProps> = ({ label, resize }) => {
  const handleKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      resize.onStep(event.key === 'ArrowLeft' ? -1 : 1, headerOf(event.currentTarget));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      resize.onAutoFit(headerOf(event.currentTarget));
    }
  };

  return (
    <span
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Ширина столбца «${label}»: тянуть мышью, двойной клик — по тексту`}
      title="Ширина столбца: тянуть, двойной клик — по тексту"
      tabIndex={0}
      onPointerDown={resize.onPointerDown}
      onDoubleClick={event => resize.onAutoFit(headerOf(event.currentTarget))}
      onClick={event => event.stopPropagation()}
      onKeyDown={handleKey}
    />
  );
};
