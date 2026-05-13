const FAILURE_TYPE_LABELS: Record<string, string> = {
  PASS_DENY: 'Доступ запрещён',
  ACCESS_ABORTED: 'Проход отменён (таймаут)',
  ACCESSABORTED: 'Проход отменён (таймаут)',
  READER_ERROR: 'Ошибка считывателя',
  FIRE_UNLOCK_BEGIN: 'Пожарная разблокировка (начало)',
  FIRE_UNLOCK_END: 'Пожарная разблокировка (конец)',
  DOOR_HOLD_BEGIN: 'Удержание двери (начало)',
  DOOR_HOLD_END: 'Удержание двери (конец)',
  BOX_OPENED: 'Корпус контроллера открыт',
  BOX_CLOSED: 'Корпус контроллера закрыт',
  AP_ONLINE_STATUS: 'Статус подключения точки',
  DEV_ACTION: 'Действие устройства',
  VOLTAGE_STATUS: 'Статус питания',
  VOLTAGE_VALUE: 'Изменение напряжения',
  LPR_NUMBER_EVENT: 'Распознан номер ТС',
  MNG_STATE_CHANGED: 'Смена режима двери',
  TEXT: 'Текстовое сообщение',
  TEXT2: 'Тревога',
  WAITING_FOR_RULE_STAGE: 'Ожидание подтверждения',
  LOCK_FAIL: 'Тревога датчика двери',
  FACE_RECOGNIZED: 'Лицо распознано',
  FACE_VERIFICATION_FAILED: 'Лицо не распознано',
  TEMPERATURE_ALERT: 'Температурная тревога',
  TEMPERATURE_FINE: 'Температура в норме',
  TEMPERATURE_WARNING: 'Температурное предупреждение',
  TEMPERATURE_VERIFICATION_FAILED: 'Проверка температуры не пройдена',
  FACE_MASK_VERIFICATION_FAILED: 'Маска отсутствует',
  FACE_MASK_VERIFICATION_PASSED: 'Маска присутствует',
  UNKNOWN: 'Неизвестное событие',
};

export const formatFailureType = (code: string | null | undefined): string => {
  if (!code) return 'Неизвестно';
  return FAILURE_TYPE_LABELS[code] ?? code;
};
