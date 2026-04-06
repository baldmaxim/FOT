import { supabase } from '../config/database.js';

interface ISetting {
  key: string;
  value: string | null;
  description: string | null;
  is_secret: boolean;
  updated_at: string;
}

let cache: Map<string, string | null> = new Map();
let cacheLoadedAt = 0;
const CACHE_TTL = 60_000; // 60 сек

const loadCache = async () => {
  if (Date.now() - cacheLoadedAt < CACHE_TTL && cache.size > 0) return;
  const { data } = await supabase.from('system_settings').select('key, value');
  cache = new Map((data || []).map((s: { key: string; value: string | null }) => [s.key, s.value]));
  cacheLoadedAt = Date.now();
};

export const settingsService = {
  async get(key: string): Promise<string | null> {
    await loadCache();
    return cache.get(key) ?? null;
  },

  async getMultiple(keys: string[]): Promise<Record<string, string | null>> {
    await loadCache();
    const result: Record<string, string | null> = {};
    for (const key of keys) {
      result[key] = cache.get(key) ?? null;
    }
    return result;
  },

  async set(key: string, value: string | null, userId: string, description?: string): Promise<void> {
    await supabase
      .from('system_settings')
      .upsert({
        key,
        value,
        description: description || null,
        is_secret: key.includes('secret') || key.includes('key'),
        updated_at: new Date().toISOString(),
        updated_by: userId,
      }, { onConflict: 'key' });
    cache.set(key, value);
  },

  async setMultiple(entries: { key: string; value: string | null; description?: string }[], userId: string): Promise<void> {
    const rows = entries.map(e => ({
      key: e.key,
      value: e.value,
      description: e.description || null,
      is_secret: e.key.includes('secret') || e.key.includes('key'),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    }));
    await supabase.from('system_settings').upsert(rows, { onConflict: 'key' });
    for (const e of entries) cache.set(e.key, e.value);
  },

  /** Все настройки (для admin UI). Секретные значения маскируются. */
  async getAll(): Promise<ISetting[]> {
    const { data } = await supabase
      .from('system_settings')
      .select('*')
      .order('key');
    return (data || []).map((s: ISetting) => ({
      ...s,
      value: s.is_secret && s.value ? '••••••••' : s.value,
    }));
  },

  /** Получить R2 конфиг (из БД, фоллбэк на .env) */
  async getR2Config(): Promise<{
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    enabled: boolean;
  }> {
    await loadCache();
    const accountId = cache.get('r2_account_id') || process.env.R2_ACCOUNT_ID || '';
    const accessKeyId = cache.get('r2_access_key_id') || process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = cache.get('r2_secret_access_key') || process.env.R2_SECRET_ACCESS_KEY || '';
    const bucketName = cache.get('r2_bucket_name') || process.env.R2_BUCKET_NAME || 'fot-documents';
    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      enabled: !!(accountId && accessKeyId && secretAccessKey),
    };
  },

  invalidateCache() {
    cacheLoadedAt = 0;
    cache.clear();
  },
};
