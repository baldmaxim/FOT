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
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [state, setState] = useState<PresenceState>(isOpen ? 'open' : 'closed');

  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    let timer = 0;

    if (isOpen) {
      setShouldRender(true);
      setState('entering');
      // Двойной rAF: дать браузеру отрисовать стартовое (скрытое) состояние,
      // затем переключить на 'open' — так CSS-переход запускается корректно.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setState('open'));
      });
    } else {
      setState('closing');
      timer = window.setTimeout(() => {
        setShouldRender(false);
        setState('closed');
      }, durationMs);
    }

    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, durationMs]);

  return { shouldRender, state };
}
