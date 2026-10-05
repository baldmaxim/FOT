/** Нормализация ФИО и запроса: регистр и «ё/е» не важны, пробелы схлопнуты. */
export const normalizeFio = (value: string): string =>
  value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * Сотрудники подачи табеля, чьё ФИО содержит запрос (подстрока в любом месте ФИО).
 * Пустой запрос — пустой список: поиск выключен, а не «совпали все».
 */
export const matchApprovalEmployees = <T extends { full_name: string }>(
  employees: readonly T[] | undefined,
  query: string,
): T[] => {
  const q = normalizeFio(query);
  if (!q || !employees) return [];
  return employees.filter(e => normalizeFio(e.full_name).includes(q));
};
