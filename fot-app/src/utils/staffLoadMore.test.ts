import { describe, it, expect } from 'vitest';
import { LOAD_MORE_THRESHOLD_ROWS, shouldLoadMore, type ILoadMoreState } from './staffLoadMore';

const base: ILoadMoreState = {
  lastVisibleIndex: 499,
  loadedCount: 500,
  hasNextPage: true,
  inFlight: false,
  isFetchingNextPage: false,
  isPlaceholderData: false,
  isFetchNextPageError: false,
};

describe('shouldLoadMore', () => {
  it('грузит у порога конца списка', () => {
    expect(shouldLoadMore(base)).toBe(true);
    expect(shouldLoadMore({ ...base, lastVisibleIndex: 500 - LOAD_MORE_THRESHOLD_ROWS })).toBe(true);
  });

  it('не грузит, пока до конца дальше порога', () => {
    expect(shouldLoadMore({ ...base, lastVisibleIndex: 500 - LOAD_MORE_THRESHOLD_ROWS - 1 })).toBe(false);
  });

  it('последняя порция загружена — стоп', () => {
    expect(shouldLoadMore({ ...base, hasNextPage: false })).toBe(false);
  });

  it('запрос уже отправлен (синхронный guard) или идёт — повторно не шлёт', () => {
    expect(shouldLoadMore({ ...base, inFlight: true })).toBe(false);
    expect(shouldLoadMore({ ...base, isFetchingNextPage: true })).toBe(false);
  });

  it('после ошибки порции автоповтора нет — только кнопкой', () => {
    expect(shouldLoadMore({ ...base, isFetchNextPageError: true })).toBe(false);
  });

  it('данные прежнего фильтра (placeholder) — не догружает порцию старого фильтра', () => {
    expect(shouldLoadMore({ ...base, isPlaceholderData: true })).toBe(false);
  });

  it('ничего не отрисовано или список пуст — не грузит', () => {
    expect(shouldLoadMore({ ...base, lastVisibleIndex: -1 })).toBe(false);
    expect(shouldLoadMore({ ...base, loadedCount: 0, lastVisibleIndex: 0 })).toBe(false);
  });
});
