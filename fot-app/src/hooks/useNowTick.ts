import { useSyncExternalStore } from 'react';

/**
 * Единый источник «сейчас» для блоков присутствия в ЛК.
 *
 * Один setInterval на всё приложение (module-singleton): полоса присутствия,
 * чипы в «Проходах СКУД» и панель дня подписываются на одно и то же значение,
 * поэтому их цифры не могут разойтись даже на секунду.
 *
 * Тик останавливается, когда нет подписчиков или вкладка скрыта — при
 * закрытом дне и в фоне таймера нет вообще.
 */

type Subscriber = () => void;

const subscribers = new Set<Subscriber>();
let timerId: number | null = null;

/** Секунды от локальной полуночи — тот же контракт, что у nowSeconds() в skudDisplay. */
const currentSeconds = (): number => {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};

/** Снимок для useSyncExternalStore: одно значение на всех подписчиков. */
let cachedSec = currentSeconds();

const getSnapshot = (): number => cachedSec;

const broadcast = (): void => {
  cachedSec = currentSeconds();
  subscribers.forEach(fn => fn());
};

const startTimer = (): void => {
  if (timerId !== null || document.hidden) return;
  timerId = window.setInterval(broadcast, 1000);
};

const stopTimer = (): void => {
  if (timerId === null) return;
  window.clearInterval(timerId);
  timerId = null;
};

const handleVisibility = (): void => {
  if (document.hidden) {
    stopTimer();
    return;
  }
  // Возврат на вкладку: сразу подтягиваем актуальное время, потом снова тикаем.
  broadcast();
  startTimer();
};

const subscribe = (fn: Subscriber): (() => void) => {
  // Первая подписка после простоя: снимок мог устареть, обновляем сразу.
  cachedSec = currentSeconds();
  subscribers.add(fn);
  if (subscribers.size === 1) {
    document.addEventListener('visibilitychange', handleVisibility);
    startTimer();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopTimer();
    }
  };
};

const noopUnsubscribe = (): void => {};
const noopSubscribe = (): (() => void) => noopUnsubscribe;

/**
 * Секунды от локальной полуночи, обновляются раз в секунду пока `active`.
 * При `active === false` подписки и таймера нет — возвращается последний снимок.
 */
export const useNowSeconds = (active: boolean): number =>
  useSyncExternalStore(active ? subscribe : noopSubscribe, getSnapshot);
