/**
 * Файлы разовой доплаты (миграция 354): что можно прикрепить — те же лимиты, что проверяет сервер
 * (payrollSupplementFilesUpload.ts, payroll-supplement-files.ts). Здесь — чтобы ошибка была до загрузки.
 */

const EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx'] as const;

/** accept у выбора файлов. */
export const SUPPLEMENT_FILE_ACCEPT = EXTENSIONS.join(',');
export const SUPPLEMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const SUPPLEMENT_FILES_MAX = 10;
/** Новых файлов за одно сохранение — не больше 50 МБ. */
export const SUPPLEMENT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

interface IFileLike {
  name: string;
  size: number;
}

const extension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
};

/**
 * Можно ли добавить выбранные файлы к уже прикреплённым (kept — остаются у доплаты) и выбранным ранее (staged):
 * текст ошибки или null. Тип окончательно проверяет сервер — по содержимому файла.
 */
export const supplementFilesError = (
  picked: readonly IFileLike[],
  kept: number,
  staged: readonly IFileLike[],
): string | null => {
  for (const file of picked) {
    if (!(EXTENSIONS as readonly string[]).includes(extension(file.name))) {
      return `Файл «${file.name}»: допустимы PDF, JPG, PNG, WEBP, DOC, DOCX`;
    }
    if (file.size <= 0) return `Файл «${file.name}» пустой`;
    if (file.size > SUPPLEMENT_FILE_MAX_BYTES) return `Файл «${file.name}» больше 25 МБ`;
  }
  if (kept + staged.length + picked.length > SUPPLEMENT_FILES_MAX) return 'Не больше 10 файлов';
  const total = [...staged, ...picked].reduce((sum, file) => sum + file.size, 0);
  if (total > SUPPLEMENT_UPLOAD_MAX_BYTES) return 'Не больше 50 МБ за одно сохранение';
  return null;
};

/** PDF и картинки открываются в просмотрщике; DOC/DOCX — сразу скачиваются. */
export const isPreviewableSupplementFile = (mimeType: string): boolean => (
  mimeType === 'application/pdf' || mimeType.startsWith('image/')
);
