/**
 * Группы отделов «Расчётов» — пункты списка «Все отделы», не категория табеля:
 *   ИТР     — ЛИНИЯ и ЛИНИЯ-Общестрой с подотделами и остальные отделы СУ-10 (бывшая группа «Офис» влита в ИТР 09.11.2026);
 *   Рабочие — все бригады (раздел «Бригады», СУ-10 и СМ).
 * СМ (кроме бригад) делится по должности (решение 11.11.2026): бригад в СМ нет, в одном отделе и машинисты, и начальник.
 * Должность ИТР (isItrPositionName) — в «ИТР», остальные и без должности — в «Рабочие». Узел СМ в дереве остаётся.
 * «Свод» делит по режиму табелирования месяца (payroll-staff-category.ts).
 * Отделы — включая неактивные: у уволенного отдел мог уже закрыться. Должность — текущая карточки, у уволенного — на дату
 * увольнения.
 */
import { query } from '../../config/postgres.js';
import {
  listCompanyDepartmentIds,
  listSectionDepartmentIds,
  type IExportDepartmentRow,
} from '../employees-export.service.js';
import { createLiniaResolver } from './payroll-staff-category.js';

export type PayrollDepartmentGroup = 'itr' | 'worker';

export const PAYROLL_DEPARTMENT_GROUPS: readonly PayrollDepartmentGroup[] = ['itr', 'worker'];

/**
 * Начала слов должности ИТР: «Начальник отдела ГПМ», «Главный механик», «инженер ПТО», «мастер ФД», «Техник ГПМ». ИТР
 * «Расчётов» включает и бывший «Офис», поэтому здесь и специалисты, и служащие (бухгалтер, секретарь, табельщица).
 */
const ITR_POSITION_STEMS: readonly string[] = [
  'начальник', 'главн', 'заместител', 'руководител', 'директор', 'инженер', 'механик', 'техник', 'мастер',
  'заведующ', 'специалист', 'прораб', 'производител', 'геодезист', 'энергетик', 'технолог', 'диспетчер',
  'бухгалтер', 'экономист', 'менеджер', 'аналитик', 'финансист', 'юрис', 'программист', 'разработчик',
  'администратор', 'координатор', 'секретар', 'кассир', 'делопроизводител', 'инспектор', 'табельщ',
  // Опечатки справочника должностей: «Руеоводитель отдела», «специналист ОК», «системный администатор».
  'руеоводител', 'специналист', 'администатор',
];

/** Сокращения ИТР — только целым словом («зав.складом», «Инж.ПТО»): «замерщик» — рабочий. */
const ITR_POSITION_ABBREVIATIONS: ReadonlySet<string> = new Set(['нач', 'зам', 'гл', 'зав', 'рук', 'инж', 'спец']);

/**
 * Должность ИТР — по началу любого слова или сокращению целым словом, без учёта регистра и ё: «Электромеханик»,
 * «Машинист», «Бригадир-Электрик» — не ИТР. Пустая должность — не ИТР.
 */
export const isItrPositionName = (name: string | null | undefined): boolean => {
  if (!name) return false;
  const words = name.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я]+/);
  return words.some(word => ITR_POSITION_ABBREVIATIONS.has(word)
    || ITR_POSITION_STEMS.some(stem => word.startsWith(stem)));
};

export interface IPayrollDepartmentGroupIds {
  /** Отделы, целиком входящие в группу. */
  itr: string[];
  worker: string[];
  /** Отделы СМ без бригад: группа — по должности сотрудника. */
  byPosition: string[];
}

/** id отделов групп; ни один отдел не попадает в два списка. */
export const payrollDepartmentGroupIds = (departments: IExportDepartmentRow[]): IPayrollDepartmentGroupIds => {
  const isLinia = createLiniaResolver(departments);
  const worker = new Set(listSectionDepartmentIds(departments, 'brigades'));
  const itr = new Set([
    ...departments.filter(dept => isLinia(dept.id)).map(dept => dept.id),
    ...listCompanyDepartmentIds(departments, 'su10'),
  ]);
  const itrIds = [...itr].filter(id => !worker.has(id));
  const taken = new Set([...itrIds, ...worker]);
  return {
    itr: itrIds,
    worker: [...worker],
    byPosition: listSectionDepartmentIds(departments, 'sm').filter(id => !taken.has(id)),
  };
};

/** Отбор группы для SQL «Расчётов» (payrollGroupFilterSql). */
export interface IPayrollGroupFilter {
  group: PayrollDepartmentGroup;
  departmentIds: string[];
  byPositionDepartmentIds: string[];
  /** Названия должностей ИТР (как в positions.name) — среди всех должностей справочника. */
  itrPositionNames: string[];
}

/** Отбор группы — по текущей структуре и справочнику должностей. */
export const loadPayrollGroupFilter = async (group: PayrollDepartmentGroup): Promise<IPayrollGroupFilter> => {
  const [departments, positions] = await Promise.all([
    query<IExportDepartmentRow>('SELECT id, parent_id, name, kind FROM org_departments'),
    query<{ name: string }>('SELECT DISTINCT name FROM positions WHERE name IS NOT NULL'),
  ]);
  const ids = payrollDepartmentGroupIds(departments);
  return {
    group,
    departmentIds: ids[group],
    byPositionDepartmentIds: ids.byPosition,
    itrPositionNames: positions.map(row => row.name).filter(isItrPositionName),
  };
};

/**
 * Условие группы по колонкам department_id и position_name выборки «Расчётов» (buildBaseCtes → filtered).
 * Параметры дописываются в params. ИТР и Рабочие не пересекаются: в отделах СМ должность либо в списке ИТР, либо нет.
 */
export const payrollGroupFilterSql = (filter: IPayrollGroupFilter, params: unknown[]): string => {
  params.push(filter.departmentIds, filter.byPositionDepartmentIds, filter.itrPositionNames);
  const departments = `$${params.length - 2}::uuid[]`;
  const byPosition = `$${params.length - 1}::uuid[]`;
  const itrNames = `$${params.length}::text[]`;
  const positionSql = filter.group === 'itr'
    ? `position_name = ANY(${itrNames})`
    : `(position_name IS NULL OR position_name <> ALL(${itrNames}))`;
  return `(department_id = ANY(${departments}) OR (department_id = ANY(${byPosition}) AND ${positionSql}))`;
};
