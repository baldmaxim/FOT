/**
 * Задачи по одной, в порядке вызова (решение пользователя 13.11.2026). Нужна там, где запуск решает не экран: после
 * invalidate React Query перезапрашивает все порции разом, а параллельные тяжёлые расчёты на сервере идут в разы
 * дольше. Отменённая в ожидании не запускается и сразу отклоняется причиной отмены; ошибка задачи очередь не
 * останавливает. Отмена во время выполнения — дело самой задачи (signal в fetch).
 */
export type SerialRunner = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');

export const createSerialRunner = (): SerialRunner => {
  let tail: Promise<void> = Promise.resolve();

  return <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
    const result = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const onAbort = (): void => settle.reject(abortReason(signal!));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Очередь идёт по выполнению, а не по ответу: отменённая в ожидании свою очередь пропускает, но не раньше
    // предыдущей задачи.
    tail = tail.then(async () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      try {
        settle.resolve(await task());
      } catch (error) {
        settle.reject(error);
      }
    });
    return result;
  };
};
