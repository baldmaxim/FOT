import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

/**
 * Закрытие модалки/панели по клику на overlay-backdrop.
 *
 * Старое поведение `onClick={onDismiss}` закрывает overlay, если кнопка
 * мыши была отпущена над ним — даже когда нажатие началось внутри панели
 * (выделение текста, перетаскивание). Хук возвращает обработчики, которые
 * вызывают onDismiss только если и mousedown, и mouseup произошли на самом
 * overlay (не на его потомках и не за его пределами).
 */
export function useOverlayDismiss(onDismiss: () => void) {
  const pointerStartedOnOverlay = useRef(false);

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    pointerStartedOnOverlay.current = e.target === e.currentTarget;
  }, []);

  const onMouseUp = useCallback(
    (e: ReactMouseEvent) => {
      const started = pointerStartedOnOverlay.current;
      pointerStartedOnOverlay.current = false;
      if (started && e.target === e.currentTarget) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  const onMouseLeave = useCallback(() => {
    pointerStartedOnOverlay.current = false;
  }, []);

  const onTouchStart = useCallback((e: ReactTouchEvent) => {
    pointerStartedOnOverlay.current = e.target === e.currentTarget;
  }, []);

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      const started = pointerStartedOnOverlay.current;
      pointerStartedOnOverlay.current = false;
      if (started && e.target === e.currentTarget) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  return { onMouseDown, onMouseUp, onMouseLeave, onTouchStart, onTouchEnd };
}
