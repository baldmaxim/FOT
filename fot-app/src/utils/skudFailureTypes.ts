const FAILURE_TYPE_LABELS: Record<string, string> = {
  PASS_DETECTED: 'Проход зафиксирован',
  PASS_DENY: 'Доступ запрещён',
  ACCESS_ABORTED: 'Проход не совершён. Истек таймаут ожидания прохода',
  ACCESSABORTED: 'Проход не совершён. Истек таймаут ожидания прохода',
  READER_ERROR: 'Ошибка считывателя',
  FIRE_UNLOCK_BEGIN: 'Пожарная разблокировка (начало)',
  FIRE_UNLOCK_END: 'Пожарная разблокировка (конец)',
  DOOR_HOLD_BEGIN: 'Удержание двери (начало)',
  DOOR_HOLD_END: 'Удержание двери (конец)',
  BOX_OPENED: 'Корпус контроллера открыт',
  BOX_CLOSED: 'Корпус контроллера закрыт',
  AP_ONLINE_STATUS: 'Связь с точкой доступа (потеря/восстановление)',
  DEV_ACTION: 'Действие устройства (карта сопровождения / шлагбаум)',
  VOLTAGE_STATUS: 'Изменение питания (сеть/АКБ)',
  VOLTAGE_VALUE: 'Изменение напряжения',
  LPR_NUMBER_EVENT: 'Распознан номер ТС',
  MNG_STATE_CHANGED: 'Смена режима двери',
  TEXT: 'Текстовое сообщение',
  TEXT2: 'Тревожное сообщение',
  ALKO_DINGO_RAW_REPORT: 'Сырой отчёт алкотестера Dingo',
  WAITING_FOR_RULE_STAGE: 'Ожидание (сопровождение/PIN/алкотестер)',
  LOCK_FAIL: 'Тревога датчика двери',
  FACE_RECOGNIZED: 'Лицо распознано',
  FACE_VERIFICATION_FAILED: 'Лицо не распознано',
  TEMPERATURE_ALERT: 'Температурная тревога',
  TEMPERATURE_FINE: 'Температура в норме',
  TEMPERATURE_WARNING: 'Температурное предупреждение',
  TEMPERATURE_VERIFICATION_FAILED: 'Проверка температуры не пройдена',
  FACE_MASK_VERIFICATION_FAILED: 'Маска отсутствует',
  FACE_MASK_VERIFICATION_SUCCESS: 'Маска присутствует',
  UNKNOWN: 'Неизвестное событие',
  passDeny: 'Доступ запрещён',
  passDeny2: 'Доступ запрещён',
  passDetected: 'Проход зафиксирован',
  accessAborted: 'Проход не совершён. Истек таймаут ожидания прохода',
  readerError: 'Ошибка считывателя',
  TYPE_7: 'Доступ запрещён',
  TYPE_12: 'Доступ запрещён',
  TYPE_24: 'Проход не совершён. Истек таймаут ожидания прохода',
  TYPE_36: 'Проход не совершён. Истек таймаут ожидания прохода',
};

export const formatFailureType = (code: string | null | undefined): string => {
  if (!code) return 'Неизвестно';
  const exact = FAILURE_TYPE_LABELS[code];
  if (exact) return exact;
  if (/^pass_?deny\d*$/i.test(code)) return 'Доступ запрещён';
  if (/^access_?aborted\d*$/i.test(code)) return 'Проход не совершён. Истек таймаут ожидания прохода';
  if (/^pass_?detected\d*$/i.test(code)) return 'Проход зафиксирован';
  return code;
};
