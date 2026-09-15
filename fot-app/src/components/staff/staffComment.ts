import type { Employee } from '../../types';

export const STAFF_COMMENT_MAX_LENGTH = 2000;

/**
 * Версия приходит с микросекундами (…:00.123456Z): часть браузеров не разбирает больше трёх
 * знаков дробной части — для показа обрезаем до миллисекунд. Для сравнения версий строка
 * передаётся на сервер как есть.
 */
export const formatStaffCommentDate = (value: string | null | undefined): string => {
  if (!value) return '';
  const date = new Date(value.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** «Иванова И. · 15.09.2026, 10:00» — автор и дата последней правки. */
export const describeStaffCommentMeta = (
  author: string | null | undefined,
  updatedAt: string | null | undefined,
): string => [author || null, formatStaffCommentDate(updatedAt) || null].filter(Boolean).join(' · ');

export const staffCommentMetaOf = (employee: Employee): string =>
  describeStaffCommentMeta(employee.staff_comment_updated_by_name, employee.staff_comment_updated_at);
