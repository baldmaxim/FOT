// Общие типы модуля «МТС Бизнес».
//
// MtsSection — дискриминированное объединение состояния секции данных:
// данные / «не подключено в тарифе МТС» (403/1010 у апстрима) / ошибка.
// Используется карточкой номера и секциями обзора.

export type MtsSection<T> =
  | { data: T }
  | { unavailable: true; message?: string; reason?: string }
  | { error: string };

export const isMtsUnavailable = (s: unknown): s is { unavailable: true; message?: string } =>
  typeof s === 'object' && s != null && (s as { unavailable?: unknown }).unavailable === true;
