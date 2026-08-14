/**
 * Ошибки KPI-контура.
 *
 * В проекте нет AppError/HttpError — используется маркер-паттерн из
 * contractor-admin.controller.ts: обычный Error с полем `__save`, которое
 * контроллер разбирает в блоке catch. Здесь он вынесен в модуль, потому что
 * бросают его сервисы (внутри транзакции), а разбирает контроллер.
 */

export interface ObjectKpiError {
  http: number;
  code?: string;
  message: string;
}

/** Возвращаемый тип `never` позволяет писать `?? failWith(...)` в выражениях. */
export const failWith = (e: ObjectKpiError): never => {
  throw Object.assign(new Error(e.message), { __save: e });
};

export const extractObjectKpiError = (error: unknown): ObjectKpiError | undefined =>
  (error as { __save?: ObjectKpiError } | null)?.__save;

/** 409: версия записи устарела — кто-то сохранил её раньше. */
export const failStaleVersion = (): never =>
  failWith({
    http: 409,
    code: 'stale_version',
    message: 'Запись изменена другим пользователем. Обновите страницу и повторите.',
  });

export const failNotFound = (what: string): never =>
  failWith({ http: 404, code: 'not_found', message: `${what} не найден` });
