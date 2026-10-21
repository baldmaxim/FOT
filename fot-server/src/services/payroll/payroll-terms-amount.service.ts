/**
 * Период таблиц окна «Справочник» на «Расчётах» (?months=): на дату (прежний клиент без параметра) или месяцы.
 *
 * Раньше здесь жила точечная правка суммы условий «с даты» — для «Доплаты за проживание» и «Удержаний».
 * Обе таблицы перешли на свои записи (миграции 320, 321: квартиры «Проживания», staff_deductions).
 */

/**
 * Какие записи показывает таблица: onDate — действующие на дату (прежнее «на сегодня»);
 * monthStarts — задевающие хоть один из месяцев (первые числа), null — весь период.
 */
export type PayrollTermsPeriod = { onDate: string } | { monthStarts: string[] | null };

/** Параметры периода для SQL: [дата или null, первые числа месяцев или null]. */
export const termsPeriodParams = (period: PayrollTermsPeriod): [string | null, string[] | null] => (
  'onDate' in period ? [period.onDate, null] : [null, period.monthStarts]
);
