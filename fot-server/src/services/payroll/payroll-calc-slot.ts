/**
 * Очередь тяжёлых расчётов «Зарплаты» (решение пользователя 13.11.2026): одновременно идёт один расчёт. Замер прода:
 * «Свод» один на сервере — 1,8 с, вместе с порциями «Расчётов» — 9,2 с; четыре порции разом — по 11–14 с вместо ~1 с.
 * Параллельные расчёты насыщают пул БД и процесс, и даже простые запросы ждут в 10–16 раз дольше. Что считается —
 * не меняется, только когда.
 *
 * Приоритеты, внутри уровня — по порядку постановки:
 *   high   — «Свод»: проходит перед ожидающими normal/low, но ждёт идущий расчёт и ранее поставленные «Своды»;
 *   normal — столбцы ФОТ «Расчётов» (calc-columns и старый список без defer_calc);
 *   low    — «Выплачено» «Условий оплаты».
 * Идущий расчёт ничто не прерывает.
 *
 * Очередь в памяти процесса: PM2 — один fork-процесс (ecosystem.config.cjs), поэтому она глобальна. При нескольких
 * процессах это свойство теряется.
 */
import { performance } from 'node:perf_hooks';
import type { Request, Response } from 'express';

export type PayrollCalcPriority = 'high' | 'normal' | 'low';

const PRIORITIES: readonly PayrollCalcPriority[] = ['high', 'normal', 'low'];

/**
 * done — расчёт выполнен для живого клиента. aborted — клиент ушёл: в ожидании (расчёт не запускался) или во время
 * расчёта (расчёт доведён до конца, ответ слать некуда). waitMs — ожидание слота, depth — сколько задач было впереди
 * (идущая + ожидающие) при постановке.
 */
export type PayrollCalcSlotOutcome<T> =
  | { status: 'done'; result: T; waitMs: number; depth: number }
  | { status: 'aborted'; waitMs: number; depth: number };

export interface IPayrollCalcQueue {
  run: <T>(priority: PayrollCalcPriority, signal: AbortSignal, work: () => Promise<T>) => Promise<PayrollCalcSlotOutcome<T>>;
  /** Идущая + ожидающие. */
  size: () => number;
}

/** Очередь на один слот с приоритетами; отменённый в ожидании удаляется и work не вызывает. */
export const createPayrollCalcQueue = (): IPayrollCalcQueue => {
  let running = false;
  const waiting: Record<PayrollCalcPriority, Array<() => void>> = { high: [], normal: [], low: [] };

  const size = (): number => (running ? 1 : 0) + PRIORITIES.reduce((sum, level) => sum + waiting[level].length, 0);

  /** Слот передаётся следующему ожидающему напрямую: между освобождением и стартом его не займёт новый вызов. */
  const release = (): void => {
    for (const level of PRIORITIES) {
      const start = waiting[level].shift();
      if (start) {
        start();
        return;
      }
    }
    running = false;
  };

  /** true — слот получен; false — отменён до получения (из очереди удалён). */
  const acquire = (priority: PayrollCalcPriority, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    if (!running) {
      running = true;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const onAbort = (): void => {
        const list = waiting[priority];
        const index = list.indexOf(start);
        if (index >= 0) list.splice(index, 1);
        resolve(false);
      };
      const start = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      waiting[priority].push(start);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  const run = async <T>(
    priority: PayrollCalcPriority,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<PayrollCalcSlotOutcome<T>> => {
    const queuedAt = performance.now();
    const depth = size();
    const granted = await acquire(priority, signal);
    const waitMs = performance.now() - queuedAt;
    if (!granted) return { status: 'aborted', waitMs, depth };
    try {
      // Клиент мог уйти в момент передачи слота — считать незачем.
      if (signal.aborted) return { status: 'aborted', waitMs, depth };
      const result = await work();
      return signal.aborted ? { status: 'aborted', waitMs, depth } : { status: 'done', result, waitMs, depth };
    } finally {
      release();
    }
  };

  return { run, size };
};

const payrollCalcQueue = createPayrollCalcQueue();

/** В лог — долгое ожидание, длинная очередь или отмена (отменённые по таймауту в Server-Timing не видны). */
const QUEUE_LOG_WAIT_MS = 2000;
const QUEUE_LOG_DEPTH = 3;

/**
 * Расчёт запроса через очередь. Клиент ушёл (закрыт ответ до отправки) — ожидающий снимается с очереди, идущий
 * доводится до конца; в обоих случаях — aborted: контроллер выходит без ответа и без лога ошибки. Ошибка work
 * освобождает слот и пробрасывается — её обрабатывает прежний catch контроллера. queue — для тестов.
 */
export const runInPayrollCalcSlot = async <T>(
  req: Request,
  res: Response,
  priority: PayrollCalcPriority,
  work: () => Promise<T>,
  queue: IPayrollCalcQueue = payrollCalcQueue,
): Promise<PayrollCalcSlotOutcome<T>> => {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  res.on('close', onClose);
  if (req.socket?.destroyed) controller.abort();
  try {
    const outcome = await queue.run(priority, controller.signal, work);
    if (outcome.status === 'aborted' || outcome.waitMs > QUEUE_LOG_WAIT_MS || outcome.depth >= QUEUE_LOG_DEPTH) {
      console.log(
        `[payroll-queue] ${req.baseUrl}${req.path} ${priority} wait=${Math.round(outcome.waitMs)} мс `
        + `depth=${outcome.depth} ${outcome.status}`,
      );
    }
    return outcome;
  } finally {
    res.off('close', onClose);
  }
};

/** Server-Timing ожидания: payroll_queue;dur=…;desc="normal depth=1". */
export const payrollQueueServerTiming = (
  priority: PayrollCalcPriority,
  outcome: { waitMs: number; depth: number },
): string => `payroll_queue;dur=${outcome.waitMs.toFixed(1)};desc="${priority} depth=${outcome.depth}"`;
