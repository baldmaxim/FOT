// Старые вложения (загруженные до latin1→utf8 фикса multer) хранятся в БД
// мусором вида «Ð_Ð_Ñ_Ð¾Ð²Ð_Ð_µ.jpeg». Backfill-скрипт переименует их в
// «Документ_{id}.{ext}», но до прогона в проде даём UI чистый fallback.

const BROKEN_HIGH_RE = /[À-ÿ]{2,}/;
const LONG_UNDERSCORES_RE = /_{3,}/;

export function isBrokenFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (BROKEN_HIGH_RE.test(name)) return true;
  if (LONG_UNDERSCORES_RE.test(name)) return true;
  return false;
}

/**
 * Возвращает имя файла, пригодное для показа. Если name похож на битую
 * двойную UTF-8→latin1 кодировку — отдаёт «Документ.ext»; иначе исходное.
 */
export function displayFileName(name: string | null | undefined): string {
  if (!name) return 'Файл';
  if (!isBrokenFileName(name)) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && dot >= name.length - 6 ? name.slice(dot) : '';
  return `Документ${ext}`;
}
