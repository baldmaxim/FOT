import crypto from 'crypto';
import type { Employee } from '../types/index.js';
import { employeeCountsCache } from './employee-counts-cache.service.js';

/**
 * In-memory кэш карточки сотрудника с ETag для HTTP 304.
 * TTL: 60с. Инвалидация по id при любых мутациях сотрудника.
 * Любая invalidate(id) также чистит кэш счётчиков
 * (employment_status / org_department_id / excluded_from_timesheet
 * могут поменяться и сдвинуть byDepartment / byStatus).
 */

interface CacheEntry {
  data: Employee;
  etag: string;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<number, CacheEntry>();

const computeEtag = (emp: Employee): string => {
  const raw = `${emp.id}:${emp.updated_at || ''}:${emp.employment_status}:${emp.is_archived}`;
  return `W/"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}"`;
};

export const employeeCache = {
  get(id: number): CacheEntry | null {
    const entry = cache.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(id);
      return null;
    }
    return entry;
  },

  set(id: number, data: Employee): CacheEntry {
    const entry: CacheEntry = {
      data,
      etag: computeEtag(data),
      expiresAt: Date.now() + TTL_MS,
    };
    cache.set(id, entry);
    return entry;
  },

  invalidate(id: number | string): void {
    cache.delete(Number(id));
    employeeCountsCache.invalidateAll();
  },

  clear(): void {
    cache.clear();
    employeeCountsCache.invalidateAll();
  },
};
