/**
 * Ширина столбцов таблицы, как в Excel («Проживание»): граница заголовка тянется мышью, двойной клик подгоняет
 * столбец под самый длинный текст. Заданные ширины — в localStorage по ключу таблицы: { [ключ столбца]: px }.
 */

/** Уже — не тянется: подпись и воронка не помещаются. */
export const COLUMN_MIN_WIDTH = 56;
/** Шире — не тянется. */
export const COLUMN_MAX_WIDTH = 800;
/** Двойной клик — не шире: длинный комментарий не растягивает столбец на весь экран. */
export const COLUMN_AUTOFIT_MAX_WIDTH = 480;
/** Шаг ← / → с клавиатуры. */
export const COLUMN_WIDTH_STEP = 16;

export type ColumnWidths = Readonly<Record<string, number>>;

export const clampColumnWidth = (width: number, max = COLUMN_MAX_WIDTH): number => (
  Math.round(Math.min(max, Math.max(COLUMN_MIN_WIDTH, width)))
);

/**
 * Ширина «по тексту»: самый длинный текст ячеек одной строкой плюс отступы ячейки или подпись заголовка с иконками —
 * что шире; не шире COLUMN_AUTOFIT_MAX_WIDTH.
 */
export const autofitColumnWidth = (
  textWidths: ReadonlyArray<number>,
  cellExtra: number,
  headerWidth: number,
): number => {
  const longest = textWidths.reduce((max, width) => Math.max(max, width), 0);
  return clampColumnWidth(Math.max(Math.ceil(longest) + cellExtra, Math.ceil(headerWidth)), COLUMN_AUTOFIT_MAX_WIDTH);
};

const STORAGE_PREFIX = 'registry-column-widths:';

export const readColumnWidths = (storageKey: string): ColumnWidths => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
      .map(([key, width]) => [key, clampColumnWidth(width)]));
  } catch {
    return {};
  }
};

export const writeColumnWidths = (storageKey: string, widths: ColumnWidths): void => {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(widths));
  } catch {
    // Хранилище недоступно (приватный режим) — ширины живут до перезагрузки.
  }
};
