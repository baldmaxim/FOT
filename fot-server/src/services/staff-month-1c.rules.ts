/**
 * API для ЗУП3 «сотрудники месяца» (/api/public/v1/staff-month) — чистые правила, без БД.
 *
 * День сотрудника — из закрытого табеля (последняя редакция согласованной подачи без аварийной пересборки), иначе из
 * живого табеля. Пара «сотрудник + дата» в двух закрытых подачах — одна, из редакции с поздним created_at, затем с
 * бóльшим id. Часы дня по объектам (parts) — разбивка табельных часов дня (как снимок timesheet_version_objects):
 * в ней есть и неявки с часами нормы (отпуск, за свой счёт, больничный). Факт — только отработанные статусы, как
 * «Зарплата бригады» (WORKED_STATUSES в brigade-salary.calc.ts). Все суммы — в целых сотых часа.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { SUMMARY_OFFICE, SUMMARY_UNKNOWN } from './payroll/payroll-summary.attribution.js';

export type StaffMonthCategory = 'worker' | 'itr' | 'office';

/** Откуда основной объект: шаги «Свода» (attributeMonths → resolveSummaryObjects). */
export type StaffMonthObjectSource =
  | 'hours' | 'mode' | 'month_hours' | 'previous_timesheet' | 'previous_hours' | 'department' | 'current_object' | 'unknown';

export interface IApiObject {
  /** UUID объекта СКУД, 'office' или 'unknown'. */
  key: string;
  id: string | null;
  name: string;
  address: string | null;
}

export const OFFICE_OBJECT: IApiObject = { key: SUMMARY_OFFICE.key, id: null, name: SUMMARY_OFFICE.name, address: null };
export const UNKNOWN_OBJECT: IApiObject = { key: SUMMARY_UNKNOWN.key, id: null, name: SUMMARY_UNKNOWN.name, address: null };

export interface IDayPart {
  key: string;
  centi: number;
}

export interface IDayRecord {
  date: string;
  source: 'closed' | 'live';
  status: string;
  /** Часы дня в табеле, сотые. У неявки — норма графика. */
  timesheetCenti: number;
  /** Разбивка timesheetCenti по объектам; Σ = timesheetCenti. */
  parts: IDayPart[];
  worked: boolean;
  /** Редакция закрытого дня; у живого — null. */
  versionId: number | null;
  /** Отдел подачи (у персональной и живого — null). */
  departmentId: string | null;
  /** Разбивка из замороженного снимка редакции. */
  frozen: boolean;
  /** День может измениться: живой в открытом месяце или из подачи на доработке. */
  preliminary: boolean;
}

export const toCenti = (hours: number): number => Math.round((Number(hours) || 0) * 100);
export const fromCenti = (centi: number): number => Math.round(centi) / 100;

/** Кандидат-редакция для пары «сотрудник + дата». */
export interface IVersionCandidate {
  versionId: number;
  createdAt: string;
}

/** Победитель среди редакций разных подач: поздний created_at, затем больший id. */
export const pickLatestVersion = <T extends IVersionCandidate>(candidates: readonly T[]): T | null => {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (!best
      || candidate.createdAt > best.createdAt
      || (candidate.createdAt === best.createdAt && candidate.versionId > best.versionId)) {
      best = candidate;
    }
  }
  return best;
};

/**
 * Части дня: целевые сотые дня раскладываются по готовой разбивке; расхождение (разбивки нет, округление) уходит в
 * «Не определён», чтобы Σ частей = часам дня.
 */
export const normalizeParts = (targetCenti: number, parts: readonly IDayPart[]): IDayPart[] => {
  const byKey = new Map<string, number>();
  for (const part of parts) {
    if (part.centi > 0) byKey.set(part.key, (byKey.get(part.key) ?? 0) + part.centi);
  }
  const sum = [...byKey.values()].reduce((total, value) => total + value, 0);
  if (targetCenti <= 0) return [];
  // Разбивки нет или она больше дня — день целиком в «Не определён»: терять или выдумывать часы нельзя.
  if (sum === 0 || sum > targetCenti) return [{ key: UNKNOWN_OBJECT.key, centi: targetCenti }];
  if (sum < targetCenti) byKey.set(UNKNOWN_OBJECT.key, (byKey.get(UNKNOWN_OBJECT.key) ?? 0) + (targetCenti - sum));
  return [...byKey].map(([key, centi]) => ({ key, centi })).sort((a, b) => a.key.localeCompare(b.key));
};

export interface IEmployeeFact {
  factCenti: number;
  factByObject: Map<string, number>;
  liveDays: number;
  preliminary: boolean;
  frozen: boolean;
}

/** Факт сотрудника: отработанные дни, по объектам; признаки живых дней и незамороженной разбивки. */
export const aggregateFact = (days: Iterable<IDayRecord>): IEmployeeFact => {
  const factByObject = new Map<string, number>();
  let factCenti = 0;
  let liveDays = 0;
  let preliminary = false;
  let frozen = true;
  for (const day of days) {
    if (day.source === 'live') liveDays += 1;
    if (day.preliminary) preliminary = true;
    if (!day.frozen && day.timesheetCenti > 0) frozen = false;
    if (!day.worked) continue;
    for (const part of day.parts) {
      factCenti += part.centi;
      factByObject.set(part.key, (factByObject.get(part.key) ?? 0) + part.centi);
    }
  }
  return { factCenti, factByObject, liveDays, preliminary, frozen };
};

const compareObjects = (dict: ReadonlyMap<string, IApiObject>, left: string, right: string): number => (
  (dict.get(left)?.name ?? left).localeCompare(dict.get(right)?.name ?? right, 'ru') || left.localeCompare(right)
);

/** Объект с наибольшими часами, «Не определён» не выбирается; ничья — по имени, затем по ключу. */
export const pickMainKnownKey = (
  hoursByKey: ReadonlyMap<string, number>,
  dict: ReadonlyMap<string, IApiObject>,
): string | null => {
  let best: string | null = null;
  for (const [key, centi] of hoursByKey) {
    if (key === UNKNOWN_OBJECT.key || centi <= 0) continue;
    const current = best === null ? -1 : hoursByKey.get(best)!;
    if (best === null || centi > current || (centi === current && compareObjects(dict, key, best) < 0)) best = key;
  }
  return best;
};

/** Часы объектов → массив ответа, по имени. */
export const objectHoursList = (
  hoursByKey: ReadonlyMap<string, number>,
  dict: ReadonlyMap<string, IApiObject>,
): Array<{ object: IApiObject; hours: number }> => [...hoursByKey]
  .filter(([, centi]) => centi > 0)
  .sort(([left], [right]) => compareObjects(dict, left, right))
  .map(([key, centi]) => ({ object: dict.get(key) ?? { ...UNKNOWN_OBJECT, key }, hours: fromCenti(centi) }));

export interface IBrigadeDayShare {
  departmentId: string;
  employeeId: number;
  date: string;
  parts: readonly IDayPart[];
}

export interface IBrigadeAggregate {
  departmentId: string;
  byObject: Map<string, number>;
  members: Map<number, { centi: number; days: number }>;
}

/** Бригады: факт членов по объектам и по людям — из дней, уже отобранных правилом дублей. */
export const aggregateBrigades = (shares: Iterable<IBrigadeDayShare>): Map<string, IBrigadeAggregate> => {
  const result = new Map<string, IBrigadeAggregate>();
  for (const share of shares) {
    let brigade = result.get(share.departmentId);
    if (!brigade) {
      brigade = { departmentId: share.departmentId, byObject: new Map(), members: new Map() };
      result.set(share.departmentId, brigade);
    }
    const centi = share.parts.reduce((sum, part) => sum + part.centi, 0);
    for (const part of share.parts) brigade.byObject.set(part.key, (brigade.byObject.get(part.key) ?? 0) + part.centi);
    const member = brigade.members.get(share.employeeId) ?? { centi: 0, days: 0 };
    member.centi += centi;
    member.days += 1;
    brigade.members.set(share.employeeId, member);
  }
  return result;
};

/** Бригада сотрудника: где больше его часов, затем больше дней, затем по имени отдела. */
export const pickEmployeeBrigade = (
  employeeId: number,
  brigades: ReadonlyMap<string, IBrigadeAggregate>,
  nameOf: (departmentId: string) => string,
): string | null => {
  let best: { id: string; centi: number; days: number } | null = null;
  for (const brigade of brigades.values()) {
    const member = brigade.members.get(employeeId);
    if (!member) continue;
    const candidate = { id: brigade.departmentId, centi: member.centi, days: member.days };
    if (!best
      || candidate.centi > best.centi
      || (candidate.centi === best.centi && candidate.days > best.days)
      || (candidate.centi === best.centi && candidate.days === best.days
        && nameOf(candidate.id).localeCompare(nameOf(best.id), 'ru') < 0)) {
      best = candidate;
    }
  }
  return best?.id ?? null;
};

// ---- Курсор: v1, снимок, фильтры, последний employee_id; подпись HMAC-SHA256 ----

export interface IStaffMonthFilters {
  object_key: string | null;
  category: StaffMonthCategory | null;
  employee_id: number | null;
  days: boolean;
}

export interface IStaffMonthCursor {
  month: string;
  snapshotId: string;
  filters: IStaffMonthFilters;
  lastEmployeeId: number;
}

const sign = (secret: string, body: string): string => createHmac('sha256', secret).update(body).digest('base64url');

export const encodeStaffMonthCursor = (cursor: IStaffMonthCursor, secret: string): string => {
  const body = Buffer.from(JSON.stringify({
    v: 1, m: cursor.month, s: cursor.snapshotId, f: cursor.filters, l: cursor.lastEmployeeId,
  }), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
};

/** null — курсор подделан, повреждён или чужой версии. */
export const decodeStaffMonthCursor = (raw: string, secret: string): IStaffMonthCursor | null => {
  const [body, signature, extra] = raw.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      v?: unknown; m?: unknown; s?: unknown; f?: IStaffMonthFilters; l?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.m !== 'string' || typeof parsed.s !== 'string'
      || !parsed.f || !Number.isSafeInteger(parsed.l)) return null;
    return { month: parsed.m, snapshotId: parsed.s, filters: parsed.f, lastEmployeeId: Number(parsed.l) };
  } catch {
    return null;
  }
};

export const sameFilters = (left: IStaffMonthFilters, right: IStaffMonthFilters): boolean => (
  left.object_key === right.object_key && left.category === right.category
  && left.employee_id === right.employee_id && left.days === right.days
);

/** Строка подходит под отбор: объект — основной или есть факт на нём; категория — месяца. */
export const matchesFilters = (
  row: { employee_id: number; category: StaffMonthCategory; mainKey: string; factByObject: ReadonlyMap<string, number> },
  filters: IStaffMonthFilters,
): boolean => {
  if (filters.employee_id !== null && row.employee_id !== filters.employee_id) return false;
  if (filters.category !== null && row.category !== filters.category) return false;
  if (filters.object_key !== null
    && row.mainKey !== filters.object_key
    && !((row.factByObject.get(filters.object_key) ?? 0) > 0)) return false;
  return true;
};

/** Страница по employee_id после курсора. */
export const pageAfter = <T extends { employee_id: number }>(
  rows: readonly T[], afterId: number | null, limit: number,
): { page: T[]; hasMore: boolean } => {
  const rest = afterId === null ? rows : rows.filter(row => row.employee_id > afterId);
  return { page: rest.slice(0, limit), hasMore: rest.length > limit };
};
