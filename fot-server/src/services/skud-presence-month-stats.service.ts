/**
 * СКУД: статистика «Сотрудники на объектах» за месяц — объект × день × число людей.
 *
 * Строится поверх того же авторизованного датасета, что и «Списки по дням»
 * (collectPresenceExport → filterPresenceExport): числа объекта совпадают в обоих файлах,
 * видимость (все / приписанные объекты / свои сотрудники) применена до агрегации.
 *
 * Сверху добавляется компания на день прохода (skud-presence-company-on-date) и
 * «Всего» — уникальные люди за день по всем показанным объектам, а не сумма строк.
 */
import { getCompanyResolveIndex } from './skud-shared.service.js';
import { normalizeMatchName } from './name-match.utils.js';
import {
  NO_OBJECT_KEY,
  type IPresenceExportDay,
  type IPresenceExportEmployee,
  type IPresenceExportGroup,
} from './skud-presence-export.service.js';
import {
  NO_COMPANY,
  NO_COMPANY_KEY,
  loadCompanyOnDateSource,
  resolveCompanyOnDate,
  type ICompanyRef,
} from './skud-presence-company-on-date.service.js';

/** Доступные месяцы: текущий и столько предыдущих (как список в окне выгрузки). */
export const MONTHS_BACK = 11;

export const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export type PresenceMonthStatsErrorCode = 'INVALID_MONTH' | 'ARCHIVE_UNKNOWN';

export class PresenceMonthStatsError extends Error {
  code: PresenceMonthStatsErrorCode;

  constructor(code: PresenceMonthStatsErrorCode, message: string) {
    super(message);
    this.name = 'PresenceMonthStatsError';
    this.code = code;
  }
}

export interface IMonthPeriod {
  /** YYYY-MM */
  month: string;
  dateFrom: string;
  /** Последний день месяца; для текущего — «сегодня» по МСК. */
  dateTo: string;
  dates: string[];
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Период месяца: текущий и MONTHS_BACK предыдущих, текущий — по «сегодня» включительно. */
export function resolveMonthPeriod(month: string, todayIso: string): IMonthPeriod {
  const match = MONTH_RE.exec(month);
  if (!match) throw new PresenceMonthStatsError('INVALID_MONTH', `Некорректный месяц: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;

  const todayYear = Number(todayIso.slice(0, 4));
  const todayMonthIndex = Number(todayIso.slice(5, 7)) - 1;
  const monthsAgo = (todayYear * 12 + todayMonthIndex) - (year * 12 + monthIndex);
  if (monthsAgo < 0 || monthsAgo > MONTHS_BACK) {
    throw new PresenceMonthStatsError('INVALID_MONTH', `Месяц вне доступного диапазона: ${month}`);
  }

  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const isCurrent = monthsAgo === 0;
  const lastIncluded = isCurrent ? Number(todayIso.slice(8, 10)) : lastDay;
  const dates: string[] = [];
  for (let day = 1; day <= lastIncluded; day += 1) dates.push(`${month}-${pad2(day)}`);

  return { month, dateFrom: dates[0], dateTo: dates[dates.length - 1], dates };
}

/** «Сентябрь 2026» — имя листа; в заголовке и имени файла — со строчной. */
export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const name = MONTH_NAMES[monthNumber - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

// ─── Агрегация ───

export interface IPresenceMonthStatsRow {
  key: string;
  name: string;
  /** По одному числу на дату периода. */
  counts: number[];
}

export interface IPresenceMonthStatsObject extends IPresenceMonthStatsRow {
  companies: IPresenceMonthStatsRow[];
}

export interface IPresenceMonthStats {
  dates: string[];
  objects: IPresenceMonthStatsObject[];
  /** Уникальные люди за день по всем объектам. */
  total: number[];
}

export type CompanyOfPerson = (
  employee: IPresenceExportEmployee,
  group: IPresenceExportGroup,
  date: string,
) => ICompanyRef;

const collator = new Intl.Collator('ru', { sensitivity: 'base' });

export const sumCounts = (counts: number[]): number => counts.reduce((sum, value) => sum + value, 0);

/** Сумма за период ↓, затем имя; «хвостовой» ключ (Без объекта / Без компании) — в конце. */
function sortRows<T extends IPresenceMonthStatsRow>(rows: T[], tailKey: string): T[] {
  return [...rows].sort((a, b) => {
    if (a.key === tailKey && b.key !== tailKey) return 1;
    if (b.key === tailKey && a.key !== tailKey) return -1;
    const diff = sumCounts(b.counts) - sumCounts(a.counts);
    return diff !== 0 ? diff : collator.compare(a.name, b.name);
  });
}

interface IRowAcc {
  key: string;
  name: string;
  perDay: Array<Set<string>>;
}

const newAcc = (key: string, name: string, size: number): IRowAcc => ({
  key,
  name,
  perDay: Array.from({ length: size }, () => new Set<string>()),
});

const toRow = (acc: IRowAcc): IPresenceMonthStatsRow => ({
  key: acc.key,
  name: acc.name,
  counts: acc.perDay.map(set => set.size),
});

/** Чистая функция: датасет (уже авторизованный и отфильтрованный) → таблица месяца. */
export function buildPresenceMonthStats(
  days: IPresenceExportDay[],
  dates: string[],
  companyOf: CompanyOfPerson,
): IPresenceMonthStats {
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const objects = new Map<string, { acc: IRowAcc; companies: Map<string, IRowAcc> }>();
  const total = Array.from({ length: dates.length }, () => new Set<string>());

  for (const day of days) {
    const index = dateIndex.get(day.date);
    if (index === undefined) continue;
    for (const object of day.objects) {
      let entry = objects.get(object.object_key);
      if (!entry) {
        entry = { acc: newAcc(object.object_key, object.object_name, dates.length), companies: new Map() };
        objects.set(object.object_key, entry);
      }
      for (const group of object.groups) {
        for (const employee of group.employees) {
          const company = companyOf(employee, group, day.date);
          let companyAcc = entry.companies.get(company.key);
          if (!companyAcc) {
            companyAcc = newAcc(company.key, company.name, dates.length);
            entry.companies.set(company.key, companyAcc);
          }
          entry.acc.perDay[index].add(employee.person_key);
          companyAcc.perDay[index].add(employee.person_key);
          total[index].add(employee.person_key);
        }
      }
    }
  }

  const rows: IPresenceMonthStatsObject[] = [...objects.values()].map(({ acc, companies }) => ({
    ...toRow(acc),
    companies: sortRows([...companies.values()].map(toRow), NO_COMPANY_KEY),
  }));

  return {
    dates,
    objects: sortRows(rows, NO_OBJECT_KEY),
    total: total.map(set => set.size),
  };
}

// ─── Компания человека ───

/**
 * Внешний (без карточки): компания — из группы Sigur, уже посчитанной в датасете.
 * Совпадение по нормализованному имени с локальной компанией сливается с ней, как на экране.
 */
export function buildExternalCompanyResolver(
  companyByNormalizedName: Map<string, string>,
  companyNameById: (companyId: string) => string | undefined,
): (group: IPresenceExportGroup) => ICompanyRef {
  return (group) => {
    const name = group.company_name?.trim();
    if (!name) return NO_COMPANY;
    const normalized = normalizeMatchName(name);
    const localId = companyByNormalizedName.get(normalized);
    if (localId) return { key: `local:${localId}`, name: companyNameById(localId) || name };
    return { key: `sigur-root:${normalized}`, name };
  };
}

/**
 * Статистика месяца по готовому датасету. Архив «Уволенные» обязателен: без него
 * дни уволенных после периода ушли бы в «Уволенные» — лучше явная ошибка.
 */
export async function computePresenceMonthStats(
  days: IPresenceExportDay[],
  period: IMonthPeriod,
): Promise<IPresenceMonthStats> {
  // Динамический импорт: сервис архива тянет Sigur-модули (как resolveTransferSegmentsInPeriod).
  const { getKnownArchiveDepartment } = await import('./employee-archive-department.service.js');
  const archive = await getKnownArchiveDepartment().catch(() => null);
  if (!archive) {
    throw new PresenceMonthStatsError('ARCHIVE_UNKNOWN', 'Не удалось определить папку «Уволенные»');
  }

  const employeeIds = new Set<number>();
  for (const day of days) {
    for (const object of day.objects) {
      for (const group of object.groups) {
        for (const employee of group.employees) {
          if (employee.employee_id !== null) employeeIds.add(employee.employee_id);
        }
      }
    }
  }

  const [source, companyIndex] = await Promise.all([
    loadCompanyOnDateSource([...employeeIds], archive.id),
    getCompanyResolveIndex(),
  ]);
  const externalCompany = buildExternalCompanyResolver(
    companyIndex.companyByNormalizedName,
    companyId => companyIndex.companyMeta.get(companyId)?.name,
  );

  return buildPresenceMonthStats(days, period.dates, (employee, group, date) => (
    employee.employee_id !== null
      ? resolveCompanyOnDate(source, employee.employee_id, date)
      : externalCompany(group)
  ));
}
