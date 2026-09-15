import { describe, it, expect } from 'vitest';
import type { Employee } from '../types';
import type { PaginatedResponse } from '../services/employeeService';
import {
  buildPageIdChunks,
  chunkCellState,
  chunkKeyTouchesEmployees,
  collectChunkReadiness,
  getNextEmployeeCursor,
  mergeEmployeePages,
  patchEmployeeInPages,
} from './staffInfiniteList';

const emp = (id: number, name = `Сотрудник ${id}`): Employee => ({ id, full_name: name } as Employee);

const page = (ids: number[], nextCursor: { name: string; id: number } | null = null): PaginatedResponse => ({
  data: ids.map(id => emp(id)),
  meta: { page: 1, pageSize: 500, total: 10, totalPages: 1, next_cursor: nextCursor },
});

describe('mergeEmployeePages / buildPageIdChunks', () => {
  it('склеивает порции по порядку и убирает повтор на границе (первое вхождение)', () => {
    const pages = [page([1, 2, 3]), page([3, 4]), page([5])];

    expect(mergeEmployeePages(pages).map(e => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPageIdChunks(pages)).toEqual([[1, 2, 3], [4], [5]]);
  });

  it('порция, состоящая только из повторов, не даёт пустого запроса', () => {
    expect(buildPageIdChunks([page([1, 2]), page([2, 1])])).toEqual([[1, 2]]);
  });

  it('пустой список', () => {
    expect(mergeEmployeePages([])).toEqual([]);
    expect(buildPageIdChunks([])).toEqual([]);
  });
});

describe('getNextEmployeeCursor', () => {
  it('курсор следующей порции или undefined на последней', () => {
    expect(getNextEmployeeCursor(page([1], { name: 'Иванов', id: 1 }))).toEqual({ name: 'Иванов', id: 1 });
    expect(getNextEmployeeCursor(page([1], null))).toBeUndefined();
    expect(getNextEmployeeCursor({ data: [], meta: { page: 1, pageSize: 500, total: 0, totalPages: 0 } })).toBeUndefined();
  });
});

describe('patchEmployeeInPages', () => {
  it('правит сотрудника во всех порциях, остальные строки не трогает', () => {
    const data = { pages: [page([1, 2]), page([2, 3])], pageParams: [null, { name: 'x', id: 2 }] };

    const patched = patchEmployeeInPages(data, 2, { position_name: 'Прораб' });

    expect(patched?.pages[0].data.find(e => e.id === 2)?.position_name).toBe('Прораб');
    expect(patched?.pages[1].data.find(e => e.id === 2)?.position_name).toBe('Прораб');
    expect(patched?.pages[0].data.find(e => e.id === 1)).toBe(data.pages[0].data[0]);
    expect(patched?.pageParams).toBe(data.pageParams);
    expect(data.pages[0].data[1].position_name).toBeUndefined();
  });

  it('нет данных — undefined', () => {
    expect(patchEmployeeInPages(undefined, 1, {})).toBeUndefined();
  });
});

describe('collectChunkReadiness / chunkCellState', () => {
  const chunk = (ids: number[], state: { success?: boolean; error?: boolean; placeholder?: boolean; data?: unknown }) => ({
    ids,
    data: state.data,
    isSuccess: state.success ?? false,
    isError: state.error ?? false,
    isPlaceholderData: state.placeholder ?? false,
  });

  it('готовы только успешные порции, упавшие — в ошибке, прочие — загружаются', () => {
    const readiness = collectChunkReadiness([
      chunk([1, 2], { success: true, data: { objects: {} } }),
      chunk([3], { error: true }),
      chunk([4], {}),
    ]);

    expect(chunkCellState(1, readiness)).toBe('ready');
    expect(chunkCellState(2, readiness)).toBe('ready');
    expect(chunkCellState(3, readiness)).toBe('error');
    expect(chunkCellState(4, readiness)).toBe('loading');
    expect(chunkCellState(99, readiness)).toBe('loading');
  });

  it('данные прежнего ключа (placeholder) не считаются готовыми — относились бы к другим людям', () => {
    const readiness = collectChunkReadiness([chunk([1], { success: true, placeholder: true, data: {} })]);

    expect(chunkCellState(1, readiness)).toBe('loading');
  });

  it('успех без данных не делает строку готовой', () => {
    const readiness = collectChunkReadiness([chunk([1], { success: true, data: undefined })]);

    expect(chunkCellState(1, readiness)).toBe('loading');
  });
});

describe('chunkKeyTouchesEmployees', () => {
  it('сравнивает id порции (последний элемент ключа) с изменёнными', () => {
    const key = ['employee-main-objects', '2026-09-15', [10, 11, 12]];

    expect(chunkKeyTouchesEmployees(key, new Set([11]))).toBe(true);
    expect(chunkKeyTouchesEmployees(key, new Set([13]))).toBe(false);
    expect(chunkKeyTouchesEmployees(['schedules', 'templates'], new Set([11]))).toBe(false);
  });
});
