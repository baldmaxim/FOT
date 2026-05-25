// Кэш ответа GET /api/employees/counts (TTL 60с).
// Инвалидация — вызывать invalidateAll() рядом с employeeCache.invalidate(id)
// при любой мутации, меняющей employment_status / org_department_id /
// excluded_from_timesheet / привязку графика (всё, что отражается в counts).

export interface IEmployeeCountsPayload {
  byDepartment: Record<string, number>;
  byStatus: { active: number; fired: number };
}

const TTL_MS = 60_000;
const cache = new Map<string, { data: IEmployeeCountsPayload; expiresAt: number }>();

export const employeeCountsCache = {
  get(key: string): IEmployeeCountsPayload | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  },

  set(key: string, data: IEmployeeCountsPayload): void {
    cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
  },

  invalidateAll(): void {
    cache.clear();
  },
};
