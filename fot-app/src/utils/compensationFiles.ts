import { SCHEDULE_FILE_ACCEPT, SCHEDULE_FILE_MAX_BYTES } from './scheduleFileQueue';

/** Файлов компенсации у сотрудника — не больше (миграция 380, как у сервера). */
export const COMPENSATION_FILES_MAX = 20;

const ALLOWED_EXTENSIONS = new Set(SCHEDULE_FILE_ACCEPT.split(','));

/**
 * Проверка выбранных файлов компенсации до отправки: расширение (как у файлов графиков — тип сервер проверяет по
 * содержимому), размер до 25 МБ, не больше 20 у сотрудника с учётом прикреплённых и ждущих загрузки. null — всё в
 * порядке, иначе текст ошибки.
 */
export const validateCompensationFiles = (files: readonly File[], alreadyCount: number): string | null => {
  if (alreadyCount + files.length > COMPENSATION_FILES_MAX) {
    return `У сотрудника не больше ${COMPENSATION_FILES_MAX} файлов компенсации`;
  }
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.has(ext)) return `Файл «${file.name}»: можно PDF, JPG, PNG, WEBP, DOC, DOCX, XLS, XLSX`;
    if (file.size > SCHEDULE_FILE_MAX_BYTES) return `Файл «${file.name}» больше 25 МБ`;
    if (file.size === 0) return `Файл «${file.name}» пустой`;
  }
  return null;
};
