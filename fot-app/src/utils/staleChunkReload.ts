// После деплоя Vite переименовывает чанки по content-hash. Открытая до деплоя вкладка
// при lazy-импорте получит 404 (nginx-fallback на index.html → MIME error). Делаем один
// автоматический reload — флаг в sessionStorage страхует от петли, если ошибка реальная.
const RELOAD_FLAG = 'fot:chunk-reload';

const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Loading chunk \d+ failed|error loading dynamically imported module|Importing a module script failed|Failed to load module script|ChunkLoadError/i;

const isChunkLoadError = (error: unknown): boolean => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return CHUNK_ERROR_RE.test(message);
};

export const tryAutoReloadOnStaleChunk = (error: unknown): boolean => {
  if (typeof window === 'undefined') return false;
  if (!isChunkLoadError(error)) return false;
  if (window.sessionStorage.getItem(RELOAD_FLAG)) return false;
  window.sessionStorage.setItem(RELOAD_FLAG, '1');
  window.location.reload();
  return true;
};

export const clearStaleChunkReloadFlag = (): void => {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(RELOAD_FLAG);
};
