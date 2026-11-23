import { useEffect } from 'react';

/** Расхождение scrollLeft меньше пикселя — то же положение (дробная прокрутка на HiDPI). */
const SAME_POSITION = 1;

/**
 * Связать горизонтальную прокрутку двух блоков; вернёт отвязку. Сначала second встаёт на позицию first. Ответное
 * событие прокрутки, которое вызвала сама синхронизация, гасится — иначе блок, прокрученный дальше, чем может второй,
 * откатывался бы к его пределу.
 */
const linkScrollLeft = (first: HTMLElement, second: HTMLElement): (() => void) => {
  const echoes = new Map<HTMLElement, number>();

  const align = (from: HTMLElement, to: HTMLElement) => {
    if (Math.abs(to.scrollLeft - from.scrollLeft) < SAME_POSITION) return;
    const before = to.scrollLeft;
    to.scrollLeft = from.scrollLeft;
    // Блок упёрся в свой предел и не сдвинулся — события не будет, ждать нечего.
    if (Math.abs(to.scrollLeft - before) >= SAME_POSITION) echoes.set(to, to.scrollLeft);
  };

  const follow = (from: HTMLElement, to: HTMLElement) => () => {
    const echo = echoes.get(from);
    if (echo !== undefined) {
      echoes.delete(from);
      if (Math.abs(from.scrollLeft - echo) < SAME_POSITION) return;
    }
    align(from, to);
  };

  const onFirst = follow(first, second);
  const onSecond = follow(second, first);
  align(first, second);
  first.addEventListener('scroll', onFirst, { passive: true });
  second.addEventListener('scroll', onSecond, { passive: true });
  return () => {
    first.removeEventListener('scroll', onFirst);
    second.removeEventListener('scroll', onSecond);
  };
};

/**
 * Одна горизонтальная прокрутка у двух блоков: прокрутили любой — второй встаёт на тот же scrollLeft («Табель →
 * По сотруднику»: сетка и «График работы» под ней — дни столбец в столбец). Первым на позицию встаёт follower.
 */
export const useSyncedScrollLeft = (leader: HTMLElement | null, follower: HTMLElement | null): void => {
  useEffect(() => (leader && follower ? linkScrollLeft(leader, follower) : undefined), [leader, follower]);
};
