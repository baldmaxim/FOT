/**
 * Ведомости выплаты из 1С по API — чистые правила (миграция 379), без БД.
 *
 * Версия ведомости («Док_Версия» — номер изменения в очереди 1С) обязательна для записи. Матрица — как у увольнений
 * (decideDismissalVersion): меньше сохранённой — stale; та же и то же содержимое — unchanged; та же и другое —
 * revision_conflict; больше — применить. Отмена версии N: ведомость с версией ≤ N не действует, новая версия > N
 * ведомость возвращает. Состояние API хранится по ГУИДу (payroll_1c_payout_api_states), отмена неизвестного ГУИДа —
 * надгробие.
 *
 * Ведомость из API меняет только API (origin = 'api'). Ведомость с тем же ГУИДом или номером и датой, загруженная
 * файлом, регистром или генератором, переходит под API — adopt (решение пользователя 25.11): строки — из 1С, решения
 * ФОТ (перенос месяца, сотрудник вручную) переносятся (carryFotDecisions). Отмена из 1С — только ведомости, уже
 * пришедшей по API (ведомость файла до её приёма — not_api_owned, как в плане этапа 2). Ведомость бригады и «ЗП к
 * выплате» API не трогает: те же деньги — «уже загружена», иначе конфликт; отмена — not_api_owned.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../utils/canonical-json.js';
import type { IPayoutApiDocument } from './payroll-1c-payouts.month-xml.js';

export type PayoutApiAction = 'new' | 'replace' | 'restore' | 'unchanged' | 'stale' | 'already_loaded' | 'adopted';

/** Ведомости не из API, которые 1С забирает под API (файл, регистр, генератор). Бригады и «ЗП к выплате» — нет. */
export const ADOPTABLE_ORIGINS: ReadonlySet<string> = new Set(['file', 'register', 'generator']);
export type PayoutApiCancelAction = 'cancelled' | 'unchanged' | 'stale';

export interface IPayoutApiState {
  version: number;
  state: 'active' | 'cancelled';
  apiHash: string | null;
  documentId: number | null;
}

/** Ведомость в ФОТ с тем же ГУИДом или «организация + номер + дата». */
export interface IStoredPayoutDoc {
  id: number;
  guid: string;
  origin: string;
  totalCents: number;
  paymentMethod: string;
  periodMonth: string;
  lines: number;
}

/** Хеш содержимого для версии: деньги (content_hash кнопки), месяц, комментарий, ID_FOT, код физлица и основание строк. */
export const payoutApiHash = (doc: Pick<IPayoutApiDocument, 'contentHash' | 'periodMonth' | 'comment' | 'lines'>): string => (
  createHash('sha256').update(canonicalJson({
    content: doc.contentHash,
    month: doc.periodMonth,
    comment: doc.comment,
    lines: doc.lines.map(line => ({ key: line.lineKey, id_fot: line.idFot, id_all: line.personIdAll, basis: line.basis })),
  })).digest('hex')
);

export type PayoutPostDecision =
  | { kind: 'apply'; action: 'new' | 'replace' | 'restore' | 'unchanged' }
  | { kind: 'apply'; action: 'adopt'; stored: IStoredPayoutDoc }
  | { kind: 'skip'; action: 'stale' | 'unchanged' }
  | { kind: 'foreign'; stored: IStoredPayoutDoc }
  | { kind: 'conflict'; code: 'revision_conflict' | 'duplicate_conflict'; message: string };

/**
 * Что сделать с пришедшей ведомостью. version = null — только проверка (dry_run): считается новее сохранённой.
 * byGuid — ведомость с этим ГУИДом; byNumber — с теми же организацией, номером и датой под другим ГУИДом.
 */
export const decidePayoutPost = (input: {
  state: IPayoutApiState | undefined;
  version: number | null;
  apiHash: string;
  byGuid: IStoredPayoutDoc | null;
  byNumber: IStoredPayoutDoc | null;
}): PayoutPostDecision => {
  const { state, version, apiHash, byGuid, byNumber } = input;
  if (state && version !== null) {
    if (version < state.version) return { kind: 'skip', action: 'stale' };
    if (version === state.version) {
      if (state.state === 'cancelled') return { kind: 'skip', action: 'stale' };
      if (state.apiHash === apiHash) return { kind: 'skip', action: 'unchanged' };
      return { kind: 'conflict', code: 'revision_conflict', message: `версия ${version} уже принята с другим содержимым` };
    }
  }
  // ГУИД — у одной ведомости ФОТ, номер и дата — у другой: запись нарушила бы уникальность — конфликт, ничего не пишется.
  if (byGuid && byNumber) {
    if (byGuid.origin !== 'api' && !ADOPTABLE_ORIGINS.has(byGuid.origin)) return { kind: 'foreign', stored: byGuid };
    return { kind: 'conflict', code: 'duplicate_conflict', message: 'номер и дата ведомости — у другой ведомости в ФОТ' };
  }
  if (byGuid && byGuid.origin !== 'api') {
    return ADOPTABLE_ORIGINS.has(byGuid.origin) ? { kind: 'apply', action: 'adopt', stored: byGuid } : { kind: 'foreign', stored: byGuid };
  }
  if (byNumber) {
    if (byNumber.origin === 'api') {
      return { kind: 'conflict', code: 'duplicate_conflict', message: 'ведомость с тем же номером и датой уже пришла по API под другим ГУИДом' };
    }
    return ADOPTABLE_ORIGINS.has(byNumber.origin) ? { kind: 'apply', action: 'adopt', stored: byNumber } : { kind: 'foreign', stored: byNumber };
  }
  if (!byGuid) return { kind: 'apply', action: 'new' };
  if (state?.state === 'cancelled' || byGuid.lines === 0) return { kind: 'apply', action: 'restore' };
  return { kind: 'apply', action: state?.apiHash === apiHash ? 'unchanged' : 'replace' };
};

export type PayoutCancelDecision =
  | { kind: 'apply' }
  | { kind: 'skip'; action: 'stale' | 'unchanged' }
  | { kind: 'conflict'; code: 'revision_conflict' | 'not_api_owned'; message: string };

/** Отмена версии version: ведомость API убирается (строки), неизвестный ГУИД — надгробие. */
export const decidePayoutCancel = (input: {
  state: IPayoutApiState | undefined;
  version: number;
  byGuid: IStoredPayoutDoc | null;
}): PayoutCancelDecision => {
  const { state, version, byGuid } = input;
  if (byGuid && byGuid.origin !== 'api') {
    return { kind: 'conflict', code: 'not_api_owned', message: 'ведомость ещё не приходила по API (файл, ведомость бригады, «ЗП к выплате») — отменить её из 1С нельзя' };
  }
  if (!state) return { kind: 'apply' };
  if (version < state.version) return { kind: 'skip', action: 'stale' };
  if (version === state.version) {
    if (state.state === 'cancelled') return { kind: 'skip', action: 'unchanged' };
    return { kind: 'conflict', code: 'revision_conflict', message: `версия ${version} уже принята как проведённая ведомость` };
  }
  return { kind: 'apply' };
};

export interface IForeignComparison {
  sameMoney: boolean;
  differences: string[];
}

/**
 * Ведомость бригады или «ЗП к выплате» под тем же ГУИДом или номером: «денежное ядро» — итог и вид выплаты. Совпали — «уже загружена» (отличия
 * месяца и числа строк — справочно: файлом её могли перенести в другой месяц или разбить строки иначе); разошлись —
 * конфликт, ничего не записывается.
 */
export const compareForeignPayout = (
  doc: Pick<IPayoutApiDocument, 'totalCents' | 'paymentMethod' | 'periodMonth' | 'lines'>,
  stored: IStoredPayoutDoc,
): IForeignComparison => {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const differences: string[] = [];
  const sameMoney = doc.totalCents === stored.totalCents && doc.paymentMethod === stored.paymentMethod;
  if (doc.totalCents !== stored.totalCents) differences.push(`итог: в ФОТ ${money(stored.totalCents)}, из 1С ${money(doc.totalCents)}`);
  if (doc.paymentMethod !== stored.paymentMethod) differences.push(`вид выплаты: в ФОТ «${stored.paymentMethod}», из 1С «${doc.paymentMethod}»`);
  if (doc.periodMonth !== stored.periodMonth) differences.push(`месяц: в ФОТ ${stored.periodMonth.slice(0, 7)}, из 1С ${doc.periodMonth.slice(0, 7)}`);
  if (doc.lines.length !== stored.lines) differences.push(`строк: в ФОТ ${stored.lines}, из 1С ${doc.lines.length}`);
  return { sameMoney, differences };
};

/** Откуда ведомость — подпись для экранов. */
export const PAYOUT_ORIGIN_LABELS: Record<string, string> = {
  api: 'API 1С',
  file: 'Файл 1С',
  register: 'Регистр ЗУП',
  generator: 'Файл 1С',
  brigade_sheet: 'Ведомость бригады',
  to_pay: 'ЗП к выплате (ЗУП2)',
};

/** Строка ведомости в ФОТ до замены: сотрудник и перенос месяца — решения ФОТ, которые замена из 1С сохраняет. */
export interface IFotLineDecision {
  line_key: string;
  full_name_1c: string;
  amount: string;
  employee_id: number | null;
  resolution: string;
  resolution_reason: string | null;
  period_month: string | null;
  period_month_reason: string | null;
}

/** Строка из 1С после сопоставления (api-lines): сотрудник и причина. */
export interface INewLineTarget {
  lineKey: string;
  amountCents: number;
  employeeId: number | null;
  resolution: 'auto_id_fot' | 'auto_id_all' | 'confirmed' | 'unmatched';
  reason: string;
}

export interface ICarriedLine {
  employeeId: number | null;
  resolution: 'auto_id_fot' | 'auto_id_all' | 'confirmed' | 'unmatched';
  reason: string;
  periodMonth: string | null;
  periodMonthReason: string | null;
}

const ymOf = (date: string): string => date.slice(0, 7);

/**
 * Решения ФОТ при замене ведомости строками из 1С (adopt, replace, restore):
 *  - пара строк — по line_key (ФИО + сумма + номер среди одинаковых), затем по «сотрудник + сумма»;
 *  - перенос месяца строки (367) остаётся у пары; ведомость целиком перенесена в ФОТ в другой месяц (storedPeriod ≠
 *    период 1С при adopt) — этот месяц у всех строк без своего переноса;
 *  - сотрудник, выбранный в ФОТ (resolution confirmed), остаётся, если 1С не прислала ID_FOT; ID_FOT главнее;
 *  - у переноса нет пары (в 1С сумма изменилась) — предупреждение; у ручного выбора — если сотрудник после замены
 *    остался без строк в ведомости (строки разбиты иначе, но человек тот же — без предупреждения).
 * Месяц строки, совпавший с периодом 1С, — без переноса (NULL).
 */
export const carryFotDecisions = (input: {
  docPeriod: string;
  docMovedTo: string | null;
  oldLines: readonly IFotLineDecision[];
  targets: readonly INewLineTarget[];
}): { lines: Map<string, ICarriedLine>; warnings: string[] } => {
  const toCentsLocal = (amount: string) => Math.round(Number(amount) * 100);
  const free = [...input.oldLines];
  const take = (match: (line: IFotLineDecision) => boolean): IFotLineDecision | null => {
    const index = free.findIndex(match);
    return index < 0 ? null : free.splice(index, 1)[0];
  };
  const pairs = new Map<string, IFotLineDecision>();
  for (const target of input.targets) {
    const old = take(line => line.line_key === target.lineKey);
    if (old) pairs.set(target.lineKey, old);
  }
  for (const target of input.targets) {
    if (pairs.has(target.lineKey) || target.employeeId === null) continue;
    const old = take(line => line.employee_id === target.employeeId && toCentsLocal(line.amount) === target.amountCents);
    if (old) pairs.set(target.lineKey, old);
  }
  const lines = new Map<string, ICarriedLine>();
  for (const target of input.targets) {
    const old = pairs.get(target.lineKey) ?? null;
    const keepEmployee = old !== null && old.resolution === 'confirmed' && old.employee_id !== null && target.resolution !== 'auto_id_fot';
    let periodMonth: string | null = null;
    let periodMonthReason: string | null = null;
    if (old?.period_month) {
      periodMonth = old.period_month;
      periodMonthReason = old.period_month_reason;
    } else if (input.docMovedTo) {
      periodMonth = input.docMovedTo;
      periodMonthReason = `ведомость перенесена в ФОТ в ${ymOf(input.docMovedTo)} до приёма по API (в 1С — ${ymOf(input.docPeriod)})`;
    }
    if (periodMonth === input.docPeriod) {
      periodMonth = null;
      periodMonthReason = null;
    }
    lines.set(target.lineKey, {
      employeeId: keepEmployee ? old.employee_id : target.employeeId,
      resolution: keepEmployee ? 'confirmed' : target.resolution,
      reason: keepEmployee ? (old.resolution_reason ?? 'выбран в ФОТ') : target.reason,
      periodMonth,
      periodMonthReason,
    });
  }
  const finalEmployees = new Set([...lines.values()].map(line => line.employeeId));
  const warnings = free
    .filter(line => line.period_month !== null
      || (line.resolution === 'confirmed' && line.employee_id !== null && !finalEmployees.has(line.employee_id)))
    .map(line => `${line.full_name_1c} ${line.amount}: в 1С строки с такой суммой нет — `
      + (line.period_month !== null ? `перенос в ${ymOf(line.period_month)} не применён` : 'сотрудник подобран заново'));
  return { lines, warnings };
};
