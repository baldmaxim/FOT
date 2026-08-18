import type { PremiumMonthStatus } from '../api/objectKpi';

/**
 * Почему премия за месяц не рассчитана. Словарь общий для ЛК руководителя и сводного
 * отчёта: два разных объяснения одного статуса — верный способ получить два разных
 * ответа на один вопрос «а почему у меня прочерк».
 */
export const PREMIUM_STATUS_TEXT: Record<PremiumMonthStatus, string> = {
  no_scale: 'Шкала премии на этот месяц не утверждена',
  not_assigned: 'В этом месяце за руководителем не было закреплённых объектов',
  no_plan: 'План месяца не определён — премия не рассчитывается (п. 4.5)',
  data_incomplete: 'По части объектов нет данных для плана — расчёт не выполняется',
  calculated: '',
};

/** Короткая подпись для узкой ячейки таблицы. */
export const PREMIUM_STATUS_SHORT: Record<PremiumMonthStatus, string> = {
  no_scale: 'нет шкалы',
  not_assigned: 'не закреплён',
  no_plan: 'нет плана',
  data_incomplete: 'нет данных',
  calculated: '',
};
