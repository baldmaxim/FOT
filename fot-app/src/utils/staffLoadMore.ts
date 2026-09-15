/** Сколько строк до конца загруженного списка начинать грузить следующую порцию. */
export const LOAD_MORE_THRESHOLD_ROWS = 100;

export interface ILoadMoreState {
  /** Индекс последней отрисованной виртуальной строки; -1 — ничего не отрисовано. */
  lastVisibleIndex: number;
  loadedCount: number;
  hasNextPage: boolean;
  /** Синхронный флаг «запрос уже отправлен» (ref): isFetchingNextPage обновляется позже. */
  inFlight: boolean;
  isFetchingNextPage: boolean;
  /** Прежние данные под новым ключом (смена фильтра): догрузка подмешала бы порцию старого фильтра. */
  isPlaceholderData: boolean;
  /** Порция упала: автоповтор у нижней границы дал бы цикл запросов, повтор — только кнопкой. */
  isFetchNextPageError: boolean;
}

export const shouldLoadMore = (state: ILoadMoreState): boolean => {
  if (!state.hasNextPage || state.inFlight || state.isFetchingNextPage) return false;
  if (state.isPlaceholderData || state.isFetchNextPageError) return false;
  if (state.loadedCount === 0 || state.lastVisibleIndex < 0) return false;
  return state.lastVisibleIndex >= state.loadedCount - LOAD_MORE_THRESHOLD_ROWS;
};
