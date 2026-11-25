/**
 * Сотрудник для физлица из выгрузки 1С (ведомости выплаты XML, реестр ФСС): по коду физлица (id_all), иначе по ФИО;
 * у тёзок — работавший в месяце (уволенный без даты увольнения — не работал), затем ранее подтверждённый под этим ФИО;
 * не решилось — без сотрудника. Кандидаты — matchPayoutLines (подрядчик в месяце не кандидат).
 *
 * Ручные решения пользователя (--link «ФИО=id», --unmatched «ФИО», applyManualRules) перекрывают автоматику, но только
 * когда однозначны: ФИО — ровно одно физлицо набора, правило использовано, код физлица 1С не ведёт к другой карточке.
 * Есть ли карточка и не подрядчик ли она в месяце — проверяет генератор (loadPayoutEligibility), как у всех.
 *
 * Общие для генераторов (scripts/lib/payouts-person-decision.ts — реэкспорт) и API ведомостей
 * (payroll-1c-payouts.api.service.ts).
 */
import type { IPayoutCandidate } from './payroll-1c-payouts.matching.js';
import { normalizePayoutName } from './payroll-1c-payouts.parser.js';

export type DecisionKind =
  | 'id_all' | 'single' | 'worked' | 'earlier' | 'ambiguous' | 'none' | 'manual' | 'manual_none' | 'id_all_none';

export const DECISION_LABELS: ReadonlyArray<[DecisionKind, string]> = [
  ['id_all', 'по коду физлица 1С (id_all)'],
  ['single', 'один кандидат по ФИО'],
  ['worked', 'тёзка — работал в месяце'],
  ['earlier', 'тёзка — подтверждён ранее под этим ФИО'],
  ['ambiguous', 'тёзки — без сотрудника'],
  ['none', 'нет в ФОТ — без сотрудника'],
  ['manual', 'указан при загрузке'],
  ['manual_none', 'без сотрудника по решению'],
  ['id_all_none', 'нет по коду физлица 1С (id_all) — без сотрудника'],
];

export const decisionLabel = (kind: DecisionKind): string => DECISION_LABELS.find(([k]) => k === kind)?.[1] ?? kind;

export interface IDecision { employeeId: number | null; kind: DecisionKind }

export const decide = (
  candidates: readonly IPayoutCandidate[], autoId: number | null, earlier: ReadonlySet<number>, firedNoDate: ReadonlySet<number>,
): IDecision => {
  if (autoId !== null) return { employeeId: autoId, kind: 'id_all' };
  if (candidates.length === 0) return { employeeId: null, kind: 'none' };
  if (candidates.length === 1) return { employeeId: candidates[0].employee_id, kind: 'single' };
  let pool = [...candidates];
  const stages: Array<[DecisionKind, (c: IPayoutCandidate) => boolean]> = [
    ['worked', c => c.worked_in_month && !firedNoDate.has(c.employee_id)],
    ['earlier', c => earlier.has(c.employee_id)],
  ];
  for (const [kind, keep] of stages) {
    const next = pool.filter(keep);
    if (next.length === 1) return { employeeId: next[0].employee_id, kind };
    if (next.length > 1) pool = next;
  }
  return { employeeId: null, kind: 'ambiguous' };
};

/**
 * Только по коду физлица 1С (выгрузка «ЗП к выплате», правило 1С «не нашли — не загрузили»): ровно один допустимый
 * сотрудник по id_all (autoId из matchPayoutLines) — он; нет, несколько или подрядчик — без сотрудника. ФИО не
 * используется даже при однозначном совпадении.
 */
export const decideByIdAll = (autoId: number | null): IDecision => (
  autoId !== null ? { employeeId: autoId, kind: 'id_all' } : { employeeId: null, kind: 'id_all_none' }
);

/** Ручные решения пользователя: нормализованное ФИО 1С → сотрудник (link) или «без сотрудника» (unmatched). */
export interface IManualRules {
  links: ReadonlyMap<string, { fullName: string; employeeId: number }>;
  unmatched: ReadonlyMap<string, { fullName: string }>;
}

/** --link «ФИО=id» и --unmatched «ФИО» → правила; пустое ФИО, плохой id, повтор ФИО — ошибка. */
export const parseManualRules = (linkArgs: readonly string[], unmatchedArgs: readonly string[]): IManualRules => {
  const links = new Map<string, { fullName: string; employeeId: number }>();
  const unmatched = new Map<string, { fullName: string }>();
  const seen = new Set<string>();
  const claim = (fullName: string, flag: string): string => {
    const key = normalizePayoutName(fullName);
    if (!key) throw new Error(`${flag}: пустое ФИО`);
    if (seen.has(key)) throw new Error(`${flag}: ФИО «${fullName}» уже есть в другом правиле`);
    seen.add(key);
    return key;
  };
  for (const arg of linkArgs) {
    const match = /^(.+)=(\d+)$/.exec(arg.trim());
    if (!match) throw new Error(`--link «${arg}»: нужно «ФИО=id сотрудника»`);
    const employeeId = Number(match[2]);
    if (!Number.isSafeInteger(employeeId) || employeeId <= 0) throw new Error(`--link «${arg}»: id сотрудника не число`);
    const fullName = match[1].trim();
    links.set(claim(fullName, '--link'), { fullName, employeeId });
  }
  for (const arg of unmatchedArgs) {
    const fullName = arg.trim();
    unmatched.set(claim(fullName, '--unmatched'), { fullName });
  }
  return { links, unmatched };
};

/** Физлицо набора для ручных правил: ключ, ФИО и код 1С, сотрудник по коду физлица (если нашёлся). */
export interface IManualRulePerson {
  key: string;
  fullName: string;
  idAll: string | null;
  autoEmployeeId: number | null;
}

/**
 * Применяет ручные правила к решениям: ФИО правила — ровно одно физлицо набора (несколько id_all под одним ФИО —
 * ошибка), правило не использовано — ошибка, код физлица 1С ведёт к другой карточке (или к любой при «без
 * сотрудника») — ошибка. Возвращает новые решения; исходные не меняет.
 */
export const applyManualRules = (
  persons: readonly IManualRulePerson[], rules: IManualRules, decisions: ReadonlyMap<string, IDecision>,
): Map<string, IDecision> => {
  const result = new Map(decisions);
  const problems: string[] = [];
  const byName = new Map<string, IManualRulePerson[]>();
  for (const person of persons) {
    const key = normalizePayoutName(person.fullName);
    byName.set(key, [...(byName.get(key) ?? []), person]);
  }
  const target = (nameKey: string, fullName: string, flag: string): IManualRulePerson | null => {
    const found = byName.get(nameKey) ?? [];
    if (found.length === 0) problems.push(`${flag} «${fullName}»: такого ФИО в файлах нет — правило не использовано`);
    if (found.length > 1) {
      problems.push(`${flag} «${fullName}»: под этим ФИО ${found.length} физлица (id_all ${found.map(p => p.idAll ?? '—').join(', ')})`);
    }
    return found.length === 1 ? found[0] : null;
  };
  for (const [nameKey, rule] of rules.links) {
    const person = target(nameKey, rule.fullName, '--link');
    if (!person) continue;
    if (person.autoEmployeeId !== null && person.autoEmployeeId !== rule.employeeId) {
      problems.push(`--link «${rule.fullName}»: код физлица 1С ведёт к сотруднику ${person.autoEmployeeId}, а не ${rule.employeeId}`);
      continue;
    }
    result.set(person.key, { employeeId: rule.employeeId, kind: 'manual' });
  }
  for (const [nameKey, rule] of rules.unmatched) {
    const person = target(nameKey, rule.fullName, '--unmatched');
    if (!person) continue;
    if (person.autoEmployeeId !== null) {
      problems.push(`--unmatched «${rule.fullName}»: код физлица 1С ведёт к сотруднику ${person.autoEmployeeId}`);
      continue;
    }
    result.set(person.key, { employeeId: null, kind: 'manual_none' });
  }
  if (problems.length > 0) throw new Error(`Ручные решения не применены:\n  ${problems.join('\n  ')}`);
  return result;
};
