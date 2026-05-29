import { useEffect, useState } from 'react';

export type PresenceState = 'entering' | 'open' | 'closing' | 'closed';

export interface IAnimatedPresence {
  /** Держать ли элемент в DOM (true пока идёт анимация выхода). */
  shouldRender: boolean;
  /** Текущая фаза — пробрасывается в `data-state` для CSS-переходов. */
  state: PresenceState;
}

/**
 * Управляет жизненным циклом монтирования для enter/exit-анимаций.
 *
 * React размонтирует элемент мгновенно, поэтому exit-анимации не успевают
 * проиграться. Хук держит элемент в DOM `durationMs` после `isOpen=false`,
 * выставляя `data-state="closing"`, и только затем убирает (`shouldRender=false`).
 *
 * Длительность брать из CSS-переменной через `readCssMs` (utils/motion).
 */
export function useAnimatedPresence(isOpen: boolean, durationMs: number): IAnimatedPresence {
  const [state, setState] = useState<PresenceState>(isOpen ? 'open' : 'closed');
  const [prevOpen, setPrevOpen] = useState(isOpen);

  // Реакция на смену isOpen во время рендера («корректировка стейта при
  // изменении пропа») — без синхронного setState внутри эффекта.
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    setState(isOpen ? 'entering' : 'closing');
  }

  // entering → open: дать кадр на отрисовку стартового (скрытого) состояния,
  // затем переключиться — так CSS-переход запускается корректно.
  useEffect(() => {
    if (state !== 'entering') return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setState('open'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [state]);

  // closing → closed: подождать exit-анимацию, затем убрать из DOM.
  useEffect(() => {
    if (state !== 'closing') return;
    const timer = window.setTimeout(() => setState('closed'), durationMs);
    return () => clearTimeout(timer);
  }, [state, durationMs]);

  return { shouldRender: state !== 'closed', state };
}
