import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ pgQuery: vi.fn(), apOptions: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery }));
vi.mock('./sigur.service.js', () => ({
  sigurService: { getAccessPointOptionsCached: h.apOptions },
}));

import { resolveObjectAccessPointIds } from './contractor-access.service.js';

describe('resolveObjectAccessPointIds', () => {
  beforeEach(() => {
    h.pgQuery.mockReset();
    h.apOptions.mockReset();
  });

  it('пустой объект → пустой результат, Sigur не дёргается', async () => {
    h.pgQuery.mockResolvedValue([]);
    const r = await resolveObjectAccessPointIds('obj-1');
    expect(r).toEqual({ accessPointIds: [], unmatchedNames: [] });
    expect(h.apOptions).not.toHaveBeenCalled();
  });

  it('сопоставляет имена ТД (регистр/пробелы) в Sigur id, собирает unmatched', async () => {
    h.pgQuery.mockResolvedValue([
      { access_point_name: 'КПП A' },
      { access_point_name: '  Офис  ' },
      { access_point_name: 'Нет такой' },
    ]);
    h.apOptions.mockResolvedValue([
      { id: 11, name: 'кпп a' },
      { id: 22, name: 'Офис' },
      { id: 33, name: 'Склад' },
    ]);
    const r = await resolveObjectAccessPointIds('obj-1');
    expect(r.accessPointIds.sort()).toEqual([11, 22]);
    expect(r.unmatchedNames).toEqual(['Нет такой']);
  });

  it('дедуплицирует id', async () => {
    h.pgQuery.mockResolvedValue([
      { access_point_name: 'A' },
      { access_point_name: 'a' },
    ]);
    h.apOptions.mockResolvedValue([{ id: 5, name: 'A' }]);
    const r = await resolveObjectAccessPointIds('obj-1');
    expect(r.accessPointIds).toEqual([5]);
  });
});
