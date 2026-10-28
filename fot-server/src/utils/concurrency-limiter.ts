/**
 * Не больше max задач одновременно, остальные ждут в очереди по порядку. Слот освобождается в finally — упавшая задача
 * очередь не останавливает. Освободившийся слот передаётся следующему ожидающему напрямую: иначе между освобождением и
 * его продолжением слот успел бы занять новый вызов, и одновременно шло бы больше max.
 */
export const createConcurrencyLimiter = (max: number) => {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => waiters.push(resolve));
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };

  return async <T>(work: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
};
