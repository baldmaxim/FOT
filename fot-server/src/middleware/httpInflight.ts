// Счётчик активных HTTP-запросов. Нужен диагностике graceful shutdown: по нему
// видно, держат ли дренирование незавершённые запросы (см. index.ts, [shutdown]).
//
// Подключается ПЕРВЫМ app.use — до helmet/cors/body parsers: запрос, оборванный
// на чтении или парсинге тела, иначе не попал бы в счётчик. Ничего не читает из
// запроса, не пишет в ответ и всегда зовёт next() — на обработку не влияет.

import type { NextFunction, Request, Response } from 'express';

let inflightCount = 0;

/** Сколько HTTP-запросов сейчас в обработке. */
export const getHttpInflight = (): number => inflightCount;

export const httpInflight = (_req: Request, res: Response, next: NextFunction): void => {
  inflightCount += 1;
  // 'finish' и 'close' приходят оба (успешный ответ), либо только 'close'
  // (клиент отвалился) — декремент строго один раз, иначе счётчик уйдёт в минус.
  let settled = false;
  const release = (): void => {
    if (settled) return;
    settled = true;
    inflightCount -= 1;
  };
  res.on('finish', release);
  res.on('close', release);
  next();
};

/** Только для тестов: сброс счётчика между кейсами. */
export const __resetHttpInflight = (): void => {
  inflightCount = 0;
};
