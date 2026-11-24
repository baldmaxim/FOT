/**
 * «Табель → Бригады → Объекты»: стоимость часа объекта и бригады на нём, подписи и поиск.
 *
 * Стоимость часа объекта — выработка бригад, внёсших её на объект, ÷ их учтённые минуты (решение 24.11): та же формула и
 * те же минуты, что у «Средней, ₽/ч» в «Зарплате по объектам» (averagePerHour). Остальные бригады объекта видны с часами
 * и причиной; «по 1 из 4 бригад» — когда вошли не все.
 */
import type {
  ITimesheetObjectsSummaryBrigade,
  ITimesheetObjectsSummaryObject,
  TimesheetObjectsSummaryExclusion,
} from '../types/timesheet';
import { createFioMatcher, includesText, withFioFallback, type FioSearchMode } from './fioSearch';
import { averagePerHour, averageTitle } from './timesheetSalary';

/** Стоимость часа объекта, ₽/ч; ни одна бригада не вошла — null. */
export const objectHourRate = (object: ITimesheetObjectsSummaryObject): string | null => (
  averagePerHour(object.output_in_rate, object.rated_minutes)
);

/** Подсказка формулы: «300 000,00 ÷ 12207,53 учтённых ч (732452 мин)». */
export const objectHourRateTitle = (object: ITimesheetObjectsSummaryObject): string | undefined => (
  averageTitle(object.output_in_rate, object.rated_minutes)
);

/** Стоимость часа бригады на объекте — только у вошедшей в расчёт. */
export const brigadeHourRate = (brigade: ITimesheetObjectsSummaryBrigade): string | null => (
  brigade.in_rate ? averagePerHour(brigade.output_amount, brigade.counted_minutes) : null
);

export const brigadeHourRateTitle = (brigade: ITimesheetObjectsSummaryBrigade): string | undefined => (
  brigade.in_rate ? averageTitle(brigade.output_amount, brigade.counted_minutes) : undefined
);

/** «из 1 бригады», «из 4 бригад», «из 21 бригады». */
const brigadesGenitive = (count: number): string => (
  count % 10 === 1 && count % 100 !== 11 ? 'бригады' : 'бригад'
);

/** «по 1 из 4 бригад» — только когда в стоимость часа вошли не все бригады объекта (и хоть одна). */
export const rateCoverageNote = (object: ITimesheetObjectsSummaryObject): string | null => {
  const total = object.brigades.length;
  if (object.brigades_in_rate === 0 || object.brigades_in_rate === total) return null;
  return `по ${object.brigades_in_rate} из ${total} ${brigadesGenitive(total)}`;
};

const EXCLUSION_TEXT: Record<TimesheetObjectsSummaryExclusion, string> = {
  no_output: 'выработка не внесена',
  by_brigade: 'выработка одной суммой на бригаду',
  nothing_to_distribute: 'нет учтённых часов',
  share_conflict: 'доли не сходятся',
  error: 'ошибка расчёта бригады',
};

/** Почему бригада не вошла в стоимость часа; вошла — null. */
export const exclusionText = (brigade: ITimesheetObjectsSummaryBrigade): string | null => (
  brigade.exclusion === null ? null : EXCLUSION_TEXT[brigade.exclusion]
);

const HOURS_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** Учтённые часы из минут: «12 207,53». */
export const formatCountedHours = (minutes: number): string => HOURS_FORMAT.format(Math.round((minutes / 60) * 100) / 100);

/** Объект в списке после поиска. */
export interface IObjectsSummaryView {
  object: ITimesheetObjectsSummaryObject;
  /** Бригады к показу: при поиске по человеку — только с найденными и только найденные в них. */
  brigades: ITimesheetObjectsSummaryBrigade[];
  /** Найден человек или бригада, а не сам объект: показать раскрытым. */
  matchedInside: boolean;
}

/**
 * Поиск по объекту, бригаде или ФИО. Совпало имя объекта — объект целиком; иначе — бригады с совпавшим названием
 * целиком и люди с совпавшим ФИО (как у поиска ФИО: точные, а без них — с одной ошибкой).
 */
export const filterObjectsSummary = (
  objects: readonly ITimesheetObjectsSummaryObject[],
  search: string,
): IObjectsSummaryView[] => {
  const whole = (object: ITimesheetObjectsSummaryObject): IObjectsSummaryView => (
    { object, brigades: object.brigades, matchedInside: false }
  );
  const matcher = createFioMatcher(search);
  if (!matcher) return objects.map(whole);
  const insideMatches = (mode: FioSearchMode): IObjectsSummaryView[] => objects.flatMap(object => {
    if (includesText(object.object_name, search)) return [];
    const brigades = object.brigades.flatMap(brigade => {
      if (matcher.matches(brigade.name, mode)) return [brigade];
      const members = (brigade.members ?? []).filter(member => matcher.matches(member.full_name, mode));
      return members.length > 0 ? [{ ...brigade, members }] : [];
    });
    return brigades.length > 0 ? [{ object, brigades, matchedInside: true }] : [];
  });
  const inside = new Map(withFioFallback(matcher, insideMatches).map(view => [view.object.object_key, view]));
  return objects.flatMap(object => {
    if (includesText(object.object_name, search)) return [whole(object)];
    const view = inside.get(object.object_key);
    return view ? [view] : [];
  });
};
