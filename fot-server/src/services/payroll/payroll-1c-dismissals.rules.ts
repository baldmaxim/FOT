/**
 * Увольнение из 1С ЗУП3 по API (POST /api/public/v1/payroll/dismissals) — чистые правила, без БД.
 *
 * Документ «Увольнение»: приказ (номер, дата, дата увольнения, основание) и начисления — компенсация отпуска и выходное
 * пособие. Версии документа — по source_revision (монотонный номер очереди 1С). Распроведён или удалён — надгробие
 * (posted: false). Исправление указывает supersedes_guid. Действующий документ — проведён и не заменён проведённым
 * потомком по цепочке исправлений. Ячейка «Оплачено» пары «сотрудник × месяц» = Σ действующих документов пары.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../utils/canonical-json.js';

export const DISMISSAL_ORGANIZATION_INNS: ReadonlySet<string> = new Set(['7736255508', '7705794997']);
export const DISMISSAL_BATCH_MAX = 200;
export type DismissalItem = 'vacation_compensation' | 'severance';
export const DISMISSAL_ITEMS: readonly DismissalItem[] = ['vacation_compensation', 'severance'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONEY_RE = /^\d{1,10}\.\d{2}$/;
const DAYS_RE = /^\d{1,4}(\.\d{1,2})?$/;

export interface IDismissalDoc {
  index: number;
  guid: string;
  sourceRevision: number;
  posted: boolean;
  supersedesGuid: string | null;
  /** Ниже — null у надгробия. */
  number: string | null;
  date: string | null;
  /** YYYY-MM. */
  month: string | null;
  organizationInn: string | null;
  employeeId: number | null;
  idAll: string | null;
  fullName: string | null;
  dismissalDate: string | null;
  basis: string | null;
  compensationCenti: number | null;
  compensationDays: string | null;
  severanceCenti: number | null;
  contentHash: string;
}

export interface IDismissalError {
  index: number | null;
  guid: string | null;
  path: string;
  message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const realDate = (value: string): boolean => {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
};

export const centiOfMoney = (value: string): number => {
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
};

/** Хеш содержимого версии: у надгробия — только guid, ревизия, posted (полная и минимальная форма совпадают). */
export const dismissalContentHash = (doc: Omit<IDismissalDoc, 'contentHash' | 'index'>): string => {
  const body = doc.posted
    ? {
      guid: doc.guid.toLowerCase(), source_revision: doc.sourceRevision, posted: true,
      supersedes_guid: doc.supersedesGuid, number: doc.number, date: doc.date, month: doc.month,
      organization_inn: doc.organizationInn, employee_id: doc.employeeId, id_all: doc.idAll, full_name: doc.fullName,
      dismissal_date: doc.dismissalDate, basis: doc.basis, vacation_compensation: doc.compensationCenti,
      vacation_compensation_days: doc.compensationDays, severance: doc.severanceCenti,
    }
    : { guid: doc.guid.toLowerCase(), source_revision: doc.sourceRevision, posted: false };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
};

/** Разбор тела `{ documents: [...] }`: все ошибки сразу, с номером документа, ГУИДом и путём поля. */
export const parseDismissalBatch = (body: unknown): { docs: IDismissalDoc[]; errors: IDismissalError[] } => {
  const errors: IDismissalError[] = [];
  const docs: IDismissalDoc[] = [];
  if (!isObject(body) || !Array.isArray(body.documents)) {
    return { docs, errors: [{ index: null, guid: null, path: 'documents', message: 'нужен массив documents' }] };
  }
  const list = body.documents as unknown[];
  if (list.length === 0 || list.length > DISMISSAL_BATCH_MAX) {
    errors.push({ index: null, guid: null, path: 'documents', message: `от 1 до ${DISMISSAL_BATCH_MAX} документов` });
  }
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const before = errors.length;
    const guidRaw = isObject(raw) && typeof raw.guid === 'string' ? raw.guid.toLowerCase() : null;
    const fail = (path: string, message: string): void => { errors.push({ index, guid: guidRaw, path: `documents[${index}].${path}`, message }); };
    if (!isObject(raw)) {
      fail('', 'документ — объект');
      return;
    }
    if (!guidRaw || !UUID_RE.test(guidRaw)) fail('guid', 'UUID документа обязателен');
    else if (seen.has(guidRaw)) fail('guid', 'ГУИД повторяется в пачке');
    else seen.add(guidRaw);
    const revision = raw.source_revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) fail('source_revision', 'целое > 0');
    if (typeof raw.posted !== 'boolean') fail('posted', 'true или false');
    const posted = raw.posted === true;
    const supersedes = raw.supersedes_guid ?? null;
    if (supersedes !== null && (typeof supersedes !== 'string' || !UUID_RE.test(supersedes))) fail('supersedes_guid', 'UUID или null');
    if (!posted) {
      if (errors.length > before) return;
      const doc = {
        guid: guidRaw!, sourceRevision: revision as number, posted: false, supersedesGuid: null,
        number: null, date: null, month: null, organizationInn: null, employeeId: null, idAll: null, fullName: null,
        dismissalDate: null, basis: null, compensationCenti: null, compensationDays: null, severanceCenti: null,
      };
      docs.push({ ...doc, index, contentHash: dismissalContentHash(doc) });
      return;
    }
    const str = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);
    const number = str(raw.number);
    if (!number || number.length > 50) fail('number', 'номер документа, до 50 символов');
    const date = str(raw.date);
    if (!date || !realDate(date)) fail('date', 'дата YYYY-MM-DD');
    const month = str(raw.month);
    if (!month || !MONTH_RE.test(month)) fail('month', 'месяц YYYY-MM');
    const inn = str(raw.organization_inn);
    if (!inn || !DISMISSAL_ORGANIZATION_INNS.has(inn)) fail('organization_inn', 'ИНН СУ-10 7736255508 или СМ 7705794997');
    const employee = isObject(raw.employee) ? raw.employee : null;
    if (!employee) fail('employee', 'объект сотрудника обязателен');
    const employeeId = employee?.employee_id;
    if (typeof employeeId !== 'number' || !Number.isSafeInteger(employeeId) || employeeId <= 0) fail('employee.employee_id', 'ID_FOT — целое > 0');
    const idAll = str(employee?.id_all);
    if (!idAll || !UUID_RE.test(idAll)) fail('employee.id_all', 'код физлица 1С — UUID, обязателен');
    const fullName = str(employee?.full_name);
    if (fullName !== null && fullName.length > 300) fail('employee.full_name', 'до 300 символов');
    const order = isObject(raw.order) ? raw.order : null;
    if (!order) fail('order', 'объект приказа обязателен');
    const dismissalDate = str(order?.dismissal_date);
    if (!dismissalDate || !realDate(dismissalDate)) fail('order.dismissal_date', 'дата YYYY-MM-DD');
    const basis = str(order?.basis);
    if (basis !== null && basis.length > 200) fail('order.basis', 'до 200 символов');
    const accruals = isObject(raw.accruals) ? raw.accruals : null;
    if (!accruals) fail('accruals', 'объект начислений обязателен');
    const compensation = accruals?.vacation_compensation;
    if (typeof compensation !== 'string' || !MONEY_RE.test(compensation)) fail('accruals.vacation_compensation', 'строка «35602.21»: 2 знака, без минуса');
    const severance = accruals?.severance;
    if (typeof severance !== 'string' || !MONEY_RE.test(severance)) fail('accruals.severance', 'строка «0.00»: 2 знака, без минуса');
    const daysRaw = accruals?.vacation_compensation_days ?? null;
    if (daysRaw !== null && (typeof daysRaw !== 'string' || !DAYS_RE.test(daysRaw))) fail('accruals.vacation_compensation_days', 'строка «12.33» или null');
    if (errors.length > before) return;
    const doc = {
      guid: guidRaw!, sourceRevision: revision as number, posted: true, supersedesGuid: (supersedes as string | null)?.toLowerCase() ?? null,
      number, date, month, organizationInn: inn, employeeId: employeeId as number, idAll: idAll!.toLowerCase(),
      fullName, dismissalDate, basis: basis || null,
      compensationCenti: centiOfMoney(compensation as string), compensationDays: daysRaw as string | null,
      severanceCenti: centiOfMoney(severance as string),
    };
    if (doc.supersedesGuid === doc.guid) {
      fail('supersedes_guid', 'документ не может исправлять сам себя');
      return;
    }
    docs.push({ ...doc, index, contentHash: dismissalContentHash(doc) });
  });
  return { docs, errors };
};

export type DismissalVersionAction = 'new' | 'updated' | 'unposted' | 'unchanged' | 'stale' | 'revision_conflict';

/** Решение по версии: сравнение с сохранённым документом того же ГУИДа. */
export const decideDismissalVersion = (
  stored: { sourceRevision: number; posted: boolean; contentHash: string } | undefined,
  incoming: Pick<IDismissalDoc, 'sourceRevision' | 'posted' | 'contentHash'>,
): DismissalVersionAction => {
  if (!stored) return incoming.posted ? 'new' : 'unposted';
  if (incoming.sourceRevision < stored.sourceRevision) return 'stale';
  if (incoming.sourceRevision === stored.sourceRevision) {
    return incoming.contentHash === stored.contentHash ? 'unchanged' : 'revision_conflict';
  }
  if (!incoming.posted) return stored.posted ? 'unposted' : 'unchanged';
  return 'updated';
};

/** Узел графа: состояние документа после применения пачки. */
export interface IDismissalNode {
  guid: string;
  posted: boolean;
  supersedesGuid: string | null;
  employeeId: number | null;
  month: string | null;
}

/**
 * Действующие документы и ошибки графа исправлений: цикл, два проведённых прямых исправления одного документа,
 * исправление другого сотрудника. Документ заменён, если у него есть проведённый потомок.
 */
export const resolveDismissalGraph = (nodes: ReadonlyMap<string, IDismissalNode>): { active: Set<string>; conflicts: string[] } => {
  const conflicts: string[] = [];
  const children = new Map<string, IDismissalNode[]>();
  for (const node of nodes.values()) {
    if (!node.supersedesGuid) continue;
    children.set(node.supersedesGuid, [...(children.get(node.supersedesGuid) ?? []), node]);
  }
  for (const node of nodes.values()) {
    const seen = new Set<string>([node.guid]);
    let current = node.supersedesGuid;
    while (current) {
      if (seen.has(current)) {
        conflicts.push(`цикл исправлений через ${node.guid}`);
        break;
      }
      seen.add(current);
      current = nodes.get(current)?.supersedesGuid ?? null;
    }
  }
  for (const [parent, list] of children) {
    if (list.filter(child => child.posted).length > 1) conflicts.push(`у документа ${parent} два проведённых исправления`);
    const base = nodes.get(parent);
    for (const child of list) {
      if (base?.posted && child.posted && base.employeeId !== null && child.employeeId !== null && base.employeeId !== child.employeeId) {
        conflicts.push(`исправление ${child.guid} — другой сотрудник, чем у ${parent}`);
      }
    }
  }
  const memo = new Map<string, boolean>();
  const hasPostedDescendant = (guid: string, path: Set<string>): boolean => {
    const cached = memo.get(guid);
    if (cached !== undefined) return cached;
    if (path.has(guid)) return false;
    path.add(guid);
    const result = (children.get(guid) ?? []).some(child => child.posted || hasPostedDescendant(child.guid, path));
    path.delete(guid);
    memo.set(guid, result);
    return result;
  };
  const active = new Set<string>();
  if (conflicts.length > 0) return { active, conflicts: [...new Set(conflicts)] };
  for (const node of nodes.values()) {
    if (node.posted && node.employeeId !== null && node.month !== null && !hasPostedDescendant(node.guid, new Set())) active.add(node.guid);
  }
  return { active, conflicts };
};

/** Текущая ячейка «Оплачено». */
export interface IPaidCell {
  amountCenti: number;
  sourceKind: string | null;
  sourceBefore: IPaidCellBefore | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export type IPaidCellBefore = { absent: true } | { amount: string; updated_by: string | null; updated_at: string | null };

export type PaidCellDecision =
  | { kind: 'keep' }
  | { kind: 'set'; amountCenti: number; before: IPaidCellBefore; took: boolean }
  | { kind: 'delete'; before: IPaidCellBefore; took: boolean }
  | { kind: 'restore'; before: IPaidCellBefore };

const centsToText = (centi: number): string => `${Math.trunc(centi / 100)}.${String(centi % 100).padStart(2, '0')}`;

/**
 * Решение по ячейке пары: есть действующие документы — ячейка = Σ (0 — строки нет), API берёт ячейку себе с прежним
 * значением; действующих нет — вернуть прежнее значение (из ячейки или из журнала, если API её удалял).
 */
export const decidePaidCell = (
  cell: IPaidCell | null,
  hasActive: boolean,
  sumCenti: number,
  journalBefore: IPaidCellBefore | null,
): PaidCellDecision => {
  const owned = cell?.sourceKind === 'api_1c_dismissal';
  if (hasActive) {
    const before: IPaidCellBefore = owned
      ? (cell!.sourceBefore ?? journalBefore ?? { absent: true })
      : cell ? { amount: centsToText(cell.amountCenti), updated_by: cell.updatedBy, updated_at: cell.updatedAt } : (journalBefore ?? { absent: true });
    const took = !owned && !(cell === null && journalBefore !== null);
    if (sumCenti > 0) {
      if (owned && cell!.amountCenti === sumCenti) return { kind: 'keep' };
      return { kind: 'set', amountCenti: sumCenti, before, took };
    }
    if (!cell) return { kind: 'keep' };
    return { kind: 'delete', before, took };
  }
  if (owned) return { kind: 'restore', before: cell!.sourceBefore ?? { absent: true } };
  if (!cell && journalBefore && !('absent' in journalBefore)) return { kind: 'restore', before: journalBefore };
  return { kind: 'keep' };
};

export type DismissalWarningCode =
  | 'fot_not_dismissed' | 'fot_dismissal_date_differs' | 'id_all_missing_in_fot' | 'month_differs_from_dismissal';

/** Предупреждения проведённого документа против карточки ФОТ (запланированное увольнение — увольнение). */
export const dismissalWarnings = (
  doc: Pick<IDismissalDoc, 'dismissalDate' | 'month'>,
  fot: { dismissalDate: string | null; idAll: string | null },
): Array<{ code: DismissalWarningCode; message: string }> => {
  const warnings: Array<{ code: DismissalWarningCode; message: string }> = [];
  if (!fot.dismissalDate) warnings.push({ code: 'fot_not_dismissed', message: 'В ФОТ у сотрудника нет даты увольнения' });
  else if (doc.dismissalDate && fot.dismissalDate !== doc.dismissalDate) {
    warnings.push({ code: 'fot_dismissal_date_differs', message: `В ФОТ дата увольнения ${fot.dismissalDate}, в приказе ${doc.dismissalDate}` });
  }
  if (!fot.idAll) warnings.push({ code: 'id_all_missing_in_fot', message: 'У сотрудника в ФОТ нет кода физлица 1С' });
  if (doc.dismissalDate && doc.month && doc.dismissalDate.slice(0, 7) !== doc.month) {
    warnings.push({ code: 'month_differs_from_dismissal', message: `Месяц документа ${doc.month}, дата увольнения ${doc.dismissalDate}` });
  }
  return warnings;
};
