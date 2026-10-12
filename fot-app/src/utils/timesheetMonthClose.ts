import { ApiError } from '../api/client';
import type {
  ITimesheetMonthCloseDepartment,
  ITimesheetMonthCloseResponse,
} from '../services/timesheetApprovalService';
import { formatTimesheetRangeLabel } from './timesheetApprovalPeriod';

/** Отделов в одном запросе — столько принимает сервер. */
export const MONTH_CLOSE_CHUNK_SIZE = 10;

export interface IMonthCloseIssue {
  departmentId: string;
  departmentName: string;
  /** Период причины; null — отдел не обработан вовсе (сбой запроса). */
  periodLabel: string | null;
  reason: string;
}

export interface IMonthCloseRunResult {
  /** Отделов, у которых этим запуском закрыта хотя бы одна половина месяца. */
  closedCount: number;
  issues: IMonthCloseIssue[];
  /** Запуск остановлен целиком (нет прав, месяц не завершён, сервер не отвечает). */
  fatalError: string | null;
}

interface IRunInput {
  month: string;
  departmentIds: readonly string[];
  nameById: ReadonlyMap<string, string>;
  closeChunk: (month: string, departmentIds: string[]) => Promise<ITimesheetMonthCloseResponse>;
  onProgress: (done: number, total: number) => void;
}

const REQUEST_FAILED_REASON = 'Не удалось закрыть — повторите выгрузку';
const TIMEOUT_REASON = 'Сервер не ответил вовремя — повторите выгрузку';
const SERVER_DOWN_ERROR =
  'Закрытие прервано: сервер не отвечает. Повторите выгрузку — уже закрытые табели не изменятся.';

/** Отказ, одинаковый для всего набора: продолжать по остальным отделам бессмысленно. */
const isFatal = (err: unknown): err is ApiError =>
  err instanceof ApiError && (err.status === 400 || err.status === 403 || err.status === 409);

/**
 * Причины, по которым отдел не закрыт. Одинаковая причина у обеих половин (строка «весь
 * месяц», нерешённые выходные) показывается одной записью за весь месяц.
 */
export const collectDepartmentIssues = (
  department: ITimesheetMonthCloseDepartment,
  fallbackName: string,
): IMonthCloseIssue[] => {
  const skipped = department.halves.filter(half => half.status === 'skipped');
  if (skipped.length === 0) return [];

  const departmentName = department.name ?? fallbackName;
  const toIssue = (startDate: string, endDate: string, reason?: string): IMonthCloseIssue => ({
    departmentId: department.department_id,
    departmentName,
    periodLabel: formatTimesheetRangeLabel(startDate, endDate),
    reason: reason ?? REQUEST_FAILED_REASON,
  });

  const allSkippedAlike = skipped.length === department.halves.length
    && skipped.every(half => half.reason === skipped[0].reason);
  if (allSkippedAlike && skipped.length > 1) {
    return [toIssue(skipped[0].start_date, skipped[skipped.length - 1].end_date, skipped[0].reason)];
  }
  return skipped.map(half => toIssue(half.start_date, half.end_date, half.reason));
};

/**
 * Закрывает табели отделов за месяц чанками, строго по очереди: сервер утверждает
 * подачи последовательно, параллельные запросы только заняли бы соединения. Повтор
 * безопасен — закрытое остаётся закрытым без новых записей в истории.
 */
export const runTimesheetMonthClose = async (input: IRunInput): Promise<IMonthCloseRunResult> => {
  const { month, nameById, closeChunk, onProgress } = input;
  const queue = [...input.departmentIds];
  const total = queue.length;
  const issues: IMonthCloseIssue[] = [];
  let done = 0;
  let closedCount = 0;
  let failedInRow = 0;

  const nameOf = (departmentId: string): string => nameById.get(departmentId) ?? departmentId;
  const failDepartments = (departmentIds: readonly string[], reason: string): void => {
    for (const departmentId of departmentIds) {
      issues.push({ departmentId, departmentName: nameOf(departmentId), periodLabel: null, reason });
    }
    done += departmentIds.length;
    onProgress(done, total);
  };

  onProgress(0, total);
  while (queue.length > 0) {
    let pendingIds = queue.splice(0, MONTH_CLOSE_CHUNK_SIZE);
    while (pendingIds.length > 0) {
      try {
        const data = await closeChunk(month, pendingIds);
        for (const department of data.results) {
          if (department.halves.some(half => half.status === 'closed')) closedCount += 1;
          issues.push(...collectDepartmentIssues(department, nameOf(department.department_id)));
        }
        done += data.results.length;
        onProgress(done, total);
        failedInRow = 0;
        // Сервер обязан продвинуться хотя бы на один отдел; иначе не зацикливаемся.
        if (data.remaining_ids.length >= pendingIds.length) {
          failDepartments(data.remaining_ids, REQUEST_FAILED_REASON);
          break;
        }
        pendingIds = data.remaining_ids;
      } catch (err) {
        if (isFatal(err)) return { closedCount, issues, fatalError: err.message };
        const timedOut = err instanceof ApiError && err.code === 'TIMEOUT';
        failDepartments(pendingIds, timedOut ? TIMEOUT_REASON : REQUEST_FAILED_REASON);
        failedInRow += 1;
        // Два сбоя подряд — сервер недоступен: дальше каждый чанк ждал бы таймаута.
        if (failedInRow >= 2 && queue.length > 0) {
          return { closedCount, issues, fatalError: SERVER_DOWN_ERROR };
        }
        break;
      }
    }
  }
  return { closedCount, issues, fatalError: null };
};
