/**
 * «Перечислено (1С)» (миграция 328): суммы ведомостей выплаты по месяцам начисления и выбор сотрудников в окне
 * загрузки. Сложение — в копейках. Справочно: в «К выплате» и расчётах не участвует.
 */
import type { IEmployeePayout1c, IPayoutPreview, IPayoutPreviewLine } from '../services/payroll1cPayoutsService';

const toCents = (amount: string): number => Math.round(Number(amount) * 100);

/** Месяц начисления → перечислено (рубли) и ведомости месяца (порядок сервера: по дате и номеру). */
export interface IPayoutMonth {
  total: number;
  documents: IEmployeePayout1c[];
}

export const payoutsByMonth = (rows: readonly IEmployeePayout1c[]): Map<string, IPayoutMonth> => {
  const cents = new Map<string, number>();
  const documents = new Map<string, IEmployeePayout1c[]>();
  for (const row of rows) {
    const value = toCents(row.amount);
    if (!Number.isFinite(value)) continue;
    cents.set(row.month, (cents.get(row.month) ?? 0) + value);
    documents.set(row.month, [...(documents.get(row.month) ?? []), row]);
  }
  return new Map([...cents].map(([month, sum]) => [month, { total: sum / 100, documents: documents.get(month) ?? [] }]));
};

/** Перечислено за месяцы (рубли); null — перечислений нет ни за один («—»). */
export const payoutsTotal = (byMonth: ReadonlyMap<string, IPayoutMonth>, months: readonly string[]): number | null => {
  let sum: number | null = null;
  for (const month of months) {
    const entry = byMonth.get(month);
    if (entry) sum = (sum ?? 0) + Math.round(entry.total * 100);
  }
  return sum === null ? null : sum / 100;
};

/** Выбор строки в окне: id сотрудника, null — «Без сотрудника», undefined — не выбран. */
export type PayoutChoice = number | null | undefined;

/** Начальный выбор: сохранённый сотрудник строки (тот же документ), иначе авто по коду 1С, иначе не выбран. */
export const initialPayoutChoice = (line: IPayoutPreviewLine): PayoutChoice => {
  if (line.current_resolution !== null) return line.current_employee_id;
  if (line.auto_employee_id !== null) return line.auto_employee_id;
  return undefined;
};

/** Строки с единственным кандидатом по ФИО, ещё не выбранные: их подтверждает кнопка «Подтвердить совпадения». */
export const singleCandidateLines = (
  preview: IPayoutPreview,
  choices: ReadonlyMap<string, PayoutChoice>,
): IPayoutPreviewLine[] => preview.lines.filter(line => (
  choices.get(line.fingerprint) === undefined && line.candidates.length === 1
));

/** Выбор для сервера: только отличия от того, что сервер возьмёт сам (сохранённое или авто). */
export const payoutChoicesPayload = (
  preview: IPayoutPreview,
  choices: ReadonlyMap<string, PayoutChoice>,
): Record<string, number | null> => {
  const payload: Record<string, number | null> = {};
  for (const line of preview.lines) {
    const choice = choices.get(line.fingerprint);
    if (choice === undefined || choice === initialPayoutChoice(line)) continue;
    payload[line.fingerprint] = choice;
  }
  return payload;
};

/** Итоги окна в копейках: с сотрудником, без сотрудника, не выбрано. */
export const payoutPreviewTotals = (preview: IPayoutPreview, choices: ReadonlyMap<string, PayoutChoice>) => {
  const totals = { matched: 0, unmatched: 0, pending: 0, pendingLines: 0 };
  for (const line of preview.lines) {
    const choice = choices.get(line.fingerprint);
    const cents = toCents(line.amount);
    if (choice === undefined) {
      totals.pending += cents;
      totals.pendingLines += 1;
    } else if (choice === null) totals.unmatched += cents;
    else totals.matched += cents;
  }
  return {
    matched: totals.matched / 100,
    unmatched: totals.unmatched / 100,
    pending: totals.pending / 100,
    pendingLines: totals.pendingLines,
  };
};

/** Изменилось ли сопоставление относительно сохранённого (для «без изменений» — это пересопоставление). */
export const payoutRelinked = (preview: IPayoutPreview, choices: ReadonlyMap<string, PayoutChoice>): boolean => (
  preview.lines.some(line => line.current_resolution !== null && choices.get(line.fingerprint) !== line.current_employee_id)
);
