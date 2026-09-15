import type { IStaffSectionDepartments } from '../services/employeeService';
import type { StaffSection } from '../components/staff/staffSections';

export type HeaderDeptFilter =
  /** Без фильтра: дерево шапки = дерево скоупа пользователя. */
  | { kind: 'none' }
  /** id разделов ещё грузятся или не загрузились: служебные корни показывать нельзя — дерево пустое. */
  | { kind: 'pending' }
  | { kind: 'ids'; ids: ReadonlySet<string> };

interface IResolveHeaderDeptFilterInput {
  section: StaffSection;
  sectionIds: IStaffSectionDepartments | undefined;
  /** Руководитель: дерево уже сужено скоупом, его отдел из «Прочих» терять нельзя. */
  restrictToManaged: boolean;
}

/**
 * Какие отделы показывать в выпадающем списке шапки.
 * «Все компании» — только ветки СУ-10 / СМ (включая бригады) / Подрядных организаций:
 * «Уволенные», «test», «Допуск Везде» сервер относит к «Прочим», и они не попадают в список.
 */
export const resolveHeaderDeptFilter = ({
  section,
  sectionIds,
  restrictToManaged,
}: IResolveHeaderDeptFilterInput): HeaderDeptFilter => {
  if (section === 'all' && restrictToManaged) return { kind: 'none' };
  if (!sectionIds) return { kind: 'pending' };
  if (section === 'all') {
    return {
      kind: 'ids',
      ids: new Set([...sectionIds.su10, ...sectionIds.sm, ...sectionIds.brigades, ...sectionIds.contractors]),
    };
  }
  return { kind: 'ids', ids: new Set(sectionIds[section]) };
};

/**
 * Выбранный отдел допустим в текущем фильтре. undefined — решение отложить (id разделов
 * ещё грузятся): сбрасывать отдел из URL до загрузки нельзя.
 */
export const isHeaderDeptAllowed = (deptId: string, filter: HeaderDeptFilter): boolean | undefined => {
  if (!deptId || filter.kind === 'none') return true;
  if (filter.kind === 'pending') return undefined;
  return filter.ids.has(deptId);
};
