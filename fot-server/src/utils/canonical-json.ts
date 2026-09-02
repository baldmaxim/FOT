// Каноническая сериализация для контентных хэшей официальных снимков.
//
// Ключи объектов сортируются лексикографически, массивы сохраняют свой порядок
// (вызывающий обязан отсортировать их сам). Без этого хэш «плавал» бы от порядка
// вставки ключей в JS-объект, и одинаковые данные давали бы разные редакции.
//
// Живёт отдельным модулем, потому что нужен и timesheet-version.service.ts, и
// timesheet-object-breakdown.service.ts: первый импортирует второй, поэтому общая
// функция не может лежать ни в одном из них — вышел бы цикл импортов.

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/** JSON канонической формы — вход для md5/sha. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
