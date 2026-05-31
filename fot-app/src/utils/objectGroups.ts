/**
 * Подготовка «объектов входа» (skud_objects) для назначения.
 *
 * Обычные объекты показываются по наименованию (name) — каждый отдельным пунктом.
 * Исключение — объекты с адресом (alt_name) «Текущая деятельность»: их несколько,
 * но они схлопываются в один пункт «Текущая деятельность» (выбор назначает/снимает
 * сразу все). Хранение в БД остаётся по object_id — группировка только для UI.
 */

export interface IAddressObject {
  id: string;
  name: string;
  alt_name?: string | null;
}

export interface IObjectGroup {
  /** Ключ пункта (id объекта или служебный ключ «текущей деятельности»). */
  key: string;
  /** Подпись пункта (наименование объекта или «Текущая деятельность»). */
  label: string;
  /** id всех объектов пункта (для обычного — один, для «текущей деятельности» — все). */
  objectIds: string[];
}

export type GroupSelectionState = 'none' | 'partial' | 'all';

export const CURRENT_ACTIVITY_LABEL = 'Текущая деятельность';
const CURRENT_ACTIVITY_KEY = '__current_activity__';

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

const isCurrentActivity = (o: IAddressObject): boolean =>
  normalize(o.alt_name ?? '') === normalize(CURRENT_ACTIVITY_LABEL);

/**
 * Пункты для UI: «Текущая деятельность» первой (если есть), далее обычные объекты
 * по наименованию (сортировка ru).
 */
export const groupObjects = (objects: IAddressObject[]): IObjectGroup[] => {
  const regular: IObjectGroup[] = [];
  const currentActivityIds: string[] = [];
  for (const o of objects) {
    if (isCurrentActivity(o)) currentActivityIds.push(o.id);
    else regular.push({ key: o.id, label: o.name, objectIds: [o.id] });
  }
  regular.sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  const result: IObjectGroup[] = [];
  if (currentActivityIds.length > 0) {
    result.push({ key: CURRENT_ACTIVITY_KEY, label: CURRENT_ACTIVITY_LABEL, objectIds: currentActivityIds });
  }
  result.push(...regular);
  return result;
};

/** Состояние пункта относительно набора назначенных id. */
export const groupSelectionState = (group: IObjectGroup, assigned: Set<string>): GroupSelectionState => {
  const n = group.objectIds.reduce((acc, id) => acc + (assigned.has(id) ? 1 : 0), 0);
  if (n === 0) return 'none';
  return n === group.objectIds.length ? 'all' : 'partial';
};

/** Подписи пунктов для набора назначенных id — для показа в столбце. */
export const objectGroupLabelsForIds = (objects: IAddressObject[], ids: string[]): string[] => {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const labels: string[] = [];
  for (const group of groupObjects(objects)) {
    if (group.objectIds.some(id => idSet.has(id))) labels.push(group.label);
  }
  return labels;
};
