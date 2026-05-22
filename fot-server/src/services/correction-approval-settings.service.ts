import { query } from '../config/postgres.js';
import { settingsService } from './settings.service.js';

/**
 * Настройка «Согласование выходных дней»: whitelist отделов (UUID), которым
 * требуется согласование работы/удалёнки в нерабочий день (корректировки
 * табеля). Чистый whitelist — отдел не в списке (в т.ч. бригады и новые
 * отделы из Sigur) согласования не требует, корректировка идёт `auto_approved`.
 *
 * Хранится в system_settings как JSON-массив UUID. Пока ключ не задан (до
 * первого сохранения админом) дефолт = все отделы kind='department' — это
 * совпадает с прежним хардкодом «обычные отделы требуют, бригады нет».
 */
const SETTING_KEY = 'correction_approval_required_department_ids';
const SETTING_DESCRIPTION =
  'Отделы, которым требуется согласование работы в выходной/праздничный день (корректировки табеля)';
const CACHE_TTL_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cache: Set<string> | null = null;
let cacheLoadedAt = 0;

/** Дефолт при отсутствии настройки: все обычные отделы (kind='department'). */
async function loadDefaultDepartmentIds(): Promise<Set<string>> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM org_departments WHERE kind = 'department'`,
  );
  return new Set(rows.map(r => String(r.id)));
}

async function loadRequiredSet(): Promise<Set<string>> {
  const raw = await settingsService.get(SETTING_KEY);
  if (raw != null && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)));
      }
    } catch {
      // битое значение — падаем на дефолт
    }
  }
  return loadDefaultDepartmentIds();
}

export const correctionApprovalSettingsService = {
  /** Множество UUID отделов, которым требуется согласование (кэш 60 c). */
  async getRequiredDepartmentIds(): Promise<Set<string>> {
    if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
    cache = await loadRequiredSet();
    cacheLoadedAt = Date.now();
    return cache;
  },

  /** Сохранить whitelist отделов. Возвращает нормализованный список UUID. */
  async setRequiredDepartmentIds(ids: string[], userId: string): Promise<string[]> {
    const valid = [...new Set(ids.filter(id => typeof id === 'string' && UUID_RE.test(id)))];
    await settingsService.set(SETTING_KEY, JSON.stringify(valid), userId, SETTING_DESCRIPTION);
    cache = new Set(valid);
    cacheLoadedAt = Date.now();
    return valid;
  },

  invalidateCache(): void {
    cache = null;
    cacheLoadedAt = 0;
  },
};
