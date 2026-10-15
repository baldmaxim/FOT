import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { buildSigurAdminEmployeesCacheKey } from './sigur-cache-keys.js';

const req = (query: Record<string, string>): Request => ({ query }) as unknown as Request;

describe('buildSigurAdminEmployeesCacheKey', () => {
  it('фильтр статуса — часть ключа: «Все» не получает ответ «Заблокированных»', () => {
    const base = { departmentId: '142603', page: '1', pageSize: '50' };
    const all = buildSigurAdminEmployeesCacheKey(req(base));
    const blocked = buildSigurAdminEmployeesCacheKey(req({ ...base, blocked: 'true' }));
    const active = buildSigurAdminEmployeesCacheKey(req({ ...base, blocked: 'false' }));

    expect(new Set([all, blocked, active]).size).toBe(3);
  });

  it('прочие параметры по-прежнему разводят ключи', () => {
    const base = { departmentId: '142603', page: '1', pageSize: '50' };
    const key = buildSigurAdminEmployeesCacheKey(req(base));

    expect(buildSigurAdminEmployeesCacheKey(req({ ...base, departmentId: '142604' }))).not.toBe(key);
    expect(buildSigurAdminEmployeesCacheKey(req({ ...base, search: 'Туров' }))).not.toBe(key);
    expect(buildSigurAdminEmployeesCacheKey(req({ ...base, page: '2' }))).not.toBe(key);
    expect(buildSigurAdminEmployeesCacheKey(req(base))).toBe(key);
  });
});
