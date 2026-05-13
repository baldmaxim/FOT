/**
 * Унифицированная нормализация ФИО для матчинга между Sigur API и локальными
 * источниками (skud_events.physical_person, org_departments.name, ...).
 *
 * Вынесено в отдельный модуль, чтобы импортироваться и из skud-shared, и из
 * sigur-presence-resolver без циклов.
 */
export function normalizeMatchName(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ').replace(/ё/g, 'е');
}

/** Первые два слова нормализованного ФИО — для prefix-матчинга (lastname + firstname). */
export function nameMatchPrefix(normalized: string): string {
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length < 2) return '';
  return `${parts[0]} ${parts[1]}`;
}
