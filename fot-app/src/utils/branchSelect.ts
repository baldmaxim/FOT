/**
 * Выбор отдела на вкладках «Управления кадрами» («Выходные», «Корректировки»): пункты селекта и какой отдел показан.
 *
 * Ручной выбор человека хранится отдельно от показанного: автовыбор (поиск сузил список, отдел исчез) его не затирает,
 * и после очистки поиска возвращается то, что человек выбрал сам.
 */

export interface IBranchSelectSource {
  id: string;
  name: string;
  /** Строк отдела после поиска. */
  visibleCount: number;
  /** Показать и без строк (открытый кнопкой табель надо уметь закрыть) — только пока нет поиска. */
  keepWhenEmpty?: boolean;
}

export interface IBranchOption {
  id: string;
  name: string;
  /** Строк после поиска: людей на «Выходных», правок на «Корректировках». */
  count: number;
}

/** Пункты: без поиска — отделы со строками и те, что надо держать пустыми; при поиске — только с совпадениями. */
export const buildBranchOptions = (
  sources: ReadonlyArray<IBranchSelectSource>,
  searching: boolean,
): IBranchOption[] => sources
  .filter(source => source.visibleCount > 0 || (!searching && source.keepWhenEmpty === true))
  .map(source => ({ id: source.id, name: source.name, count: source.visibleCount }));

export const branchOptionLabel = (option: IBranchOption): string => `${option.name} (${option.count})`;

/** Показанный отдел: ручной выбор, если он в списке, иначе первый; список пуст — null. */
export const resolveSelectedBranch = (
  options: ReadonlyArray<IBranchOption>,
  manualId: string | null,
): string | null => {
  if (manualId && options.some(option => option.id === manualId)) return manualId;
  return options[0]?.id ?? null;
};

/** Сохранённый ручной выбор. Хранилище недоступно (приватный режим, запрет) — null, экран работает и без него. */
export const readStoredBranch = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeStoredBranch = (key: string, branchId: string): void => {
  try {
    window.localStorage.setItem(key, branchId);
  } catch {
    // Не сохранилось — выбор живёт до перезагрузки страницы.
  }
};
