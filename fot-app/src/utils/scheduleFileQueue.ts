/** Итог очереди: что осталось незагруженным (упавший + необработанные) и текст первой ошибки. */
export interface IUploadQueueResult<T> {
  remaining: T[];
  error: string | null;
}

/**
 * Загрузить файлы по одному. После каждого успешного — onUploaded(file): вызывающий убирает его из своей
 * очереди, поэтому повтор после сбоя не загрузит его второй раз. Первая ошибка останавливает очередь.
 */
export const uploadQueue = async <T>(
  files: readonly T[],
  uploadOne: (file: T) => Promise<unknown>,
  onUploaded: (file: T) => void,
): Promise<IUploadQueueResult<T>> => {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    try {
      await uploadOne(file);
    } catch (err) {
      return {
        remaining: files.slice(index),
        error: err instanceof Error ? err.message : 'Ошибка загрузки файла',
      };
    }
    onUploaded(file);
  }
  return { remaining: [], error: null };
};

/** Ключ React Query списка файлов графика. */
export const scheduleFilesQueryKey = (scheduleId: string) => ['schedule-files', scheduleId] as const;

/** Расширения, которые принимает сервер (тип проверяется там по содержимому). */
export const SCHEDULE_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx';
export const SCHEDULE_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const SCHEDULE_FILES_MAX = 20;

const ALLOWED_EXTENSIONS = new Set(SCHEDULE_FILE_ACCEPT.split(','));

/**
 * Проверка выбранных файлов до отправки: расширение, размер, предел на график с учётом уже
 * прикреплённых и ждущих загрузки. null — всё в порядке, иначе текст ошибки.
 */
export const validateScheduleFiles = (
  files: readonly File[],
  alreadyCount: number,
): string | null => {
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `Файл «${file.name}»: можно PDF, JPG, PNG, WEBP, DOC, DOCX, XLS, XLSX`;
    }
    if (file.size > SCHEDULE_FILE_MAX_BYTES) return `Файл «${file.name}» больше 25 МБ`;
    if (file.size === 0) return `Файл «${file.name}» пустой`;
  }
  if (alreadyCount + files.length > SCHEDULE_FILES_MAX) {
    return `У графика не больше ${SCHEDULE_FILES_MAX} файлов`;
  }
  return null;
};
