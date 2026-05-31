/**
 * Группировка «объектов входа» (skud_objects) по адресу (alt_name).
 *
 * Несколько объектов с одинаковым адресом (например, 3 офиса с адресом
 * «Текущая деятельность») схлопываются в один выбираемый пункт. Выбор пункта
 * назначает/снимает сразу все объекты этого адреса. Хранение в БД остаётся
 * по object_id — группировка только для UI.
 */

export interface IAddressObject {
  id: string;
  name: string;
  alt_name?: string | null;
}

export interface IObjectGroup {
  /** Нормализованный ключ (для сравнения/дедупликации). */
  key: string;
  /** Человекочитаемый адрес (alt_name или name). */
  label: string;
  /** id всех объектов с этим адресом. */
  objectIds: string[];
}

export type GroupSelectionState = 'none' | 'partial' | 'all';

/** Адрес объекта: alt_name, если задан, иначе name. */
export const objectAddress = (o: IAddressObject): string => {
  const alt = o.alt_name?.trim();
  return alt && alt.length > 0 ? alt : o.name;
};

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

/** Группы объектов по адресу, отсортированы по адресу (ru). */
export const groupObjectsByAddress = (objects: IAddressObject[]): IObjectGroup[] => {
  const map = new Map<string, IObjectGroup>();
  for (const o of objects) {
    const label = objectAddress(o);
    const key = normalize(label);
    const existing = map.get(key);
    if (existing) existing.objectIds.push(o.id);
    else map.set(key, { key, label, objectIds: [o.id] });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
};

/** Состояние группы относительно набора назначенных id. */
export const groupSelectionState = (group: IObjectGroup, assigned: Set<string>): GroupSelectionState => {
  const n = group.objectIds.reduce((acc, id) => acc + (assigned.has(id) ? 1 : 0), 0);
  if (n === 0) return 'none';
  return n === group.objectIds.length ? 'all' : 'partial';
};

/** Адреса (метки групп) для набора назначенных id — для показа в столбце. */
export const objectGroupLabelsForIds = (objects: IAddressObject[], ids: string[]): string[] => {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const labels: string[] = [];
  for (const group of groupObjectsByAddress(objects)) {
    if (group.objectIds.some(id => idSet.has(id))) labels.push(group.label);
  }
  return labels;
};
