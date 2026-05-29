/**
 * Чтение длительности из CSS-переменной transitions.dev (`--modal-close-dur` и т.п.),
 * чтобы JS-таймеры были синхронны со значениями в index.css. Возвращает миллисекунды.
 */
export const readCssMs = (varName: string, fallback: number): number => {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  if (raw.endsWith('ms')) return n;
  if (raw.endsWith('s')) return n * 1000;
  return n;
};

/** Объединение className-ов (CSS Modules + опциональные внешние классы). */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');
