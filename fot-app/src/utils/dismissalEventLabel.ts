/** Поля события увольнения из ленты «История» (event_type = 'dismissal'). */
interface IDismissalEventData {
  rehired?: unknown;
  cancelled?: unknown;
}

/**
 * Подпись события увольнения в «Истории»: восстановление и отмена запланированного
 * увольнения хранятся той же таблицей событий, но это не «Увольнение».
 */
export const dismissalEventLabel = (data: IDismissalEventData): string => {
  if (data.rehired === true) return 'Восстановление';
  if (data.cancelled === true) return 'Отмена увольнения';
  return 'Увольнение';
};

/**
 * Показывать ли дату увольнения в деталях события: у восстановления это прежняя
 * дата увольнения — рядом с датой восстановления она только путает.
 */
export const showDismissalEventDate = (data: IDismissalEventData & { dismissal_date?: unknown }): boolean =>
  Boolean(data.dismissal_date) && data.rehired !== true;
