/**
 * Место и дата нарушения у удержания (миграция 383): объект (skud_objects), уточнение текстом, дата. Поля — только у
 * вида с признаком requires_place_date («Нарушение техники безопасности»); у прочих видов не хранятся.
 *
 * Объект и дата у такого вида обязательны. Исключение — правка строки того же вида, у которой места и даты не было
 * (прежние строки до миграции 383, загрузки из 1С) и в окне их по-прежнему не заполнили: строка правится как раньше.
 * Тот же разбор — на фронте (staffDeductionForm.ts).
 */

export interface IStaffDeductionViolation {
  /** uuid объекта skud_objects; нет — null. */
  violation_object_id: string | null;
  /** Уточнение места; нет — null. */
  violation_place: string | null;
  /** YYYY-MM-DD; нет — null. */
  violation_date: string | null;
}

export const EMPTY_VIOLATION: IStaffDeductionViolation = {
  violation_object_id: null,
  violation_place: null,
  violation_date: null,
};

const isEmptyViolation = (value: IStaffDeductionViolation): boolean => (
  value.violation_object_id === null && value.violation_place === null && value.violation_date === null
);

/**
 * Что записать в строку: requiresPlaceDate — признак вида, input — присланное, before — строка до правки (при
 * добавлении нет). 'place_required' — у вида с признаком нет объекта или даты.
 */
export const resolveViolationFields = (
  requiresPlaceDate: boolean,
  kindId: number,
  input: IStaffDeductionViolation,
  before?: IStaffDeductionViolation & { kind_id: number },
): IStaffDeductionViolation | 'place_required' => {
  if (!requiresPlaceDate) return EMPTY_VIOLATION;
  // Не прислано — нет (вызовы сервиса из скриптов и старых тестов полей нарушения не передают).
  const given: IStaffDeductionViolation = {
    violation_object_id: input.violation_object_id ?? null,
    violation_place: input.violation_place ?? null,
    violation_date: input.violation_date ?? null,
  };
  if (given.violation_object_id !== null && given.violation_date !== null) return given;
  const legacyRow = before !== undefined && before.kind_id === kindId && isEmptyViolation(before);
  return legacyRow && isEmptyViolation(given) ? EMPTY_VIOLATION : 'place_required';
};
