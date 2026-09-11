import { ApiError } from '../../api/client';
import { adminService } from '../../services/adminService';

/** Подсказка браузеру; настоящую проверку по содержимому делает сервер. */
export const MEMO_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx';

export const MEMO_MAX_BYTES = 25 * 1024 * 1024;

/** Текст ошибки загрузки записки для человека. */
export const memoErrorText = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 403 && /2FA/i.test(error.message)) {
      return 'Подтвердите вход кодом двухфакторной аутентификации и повторите.';
    }
    return error.message;
  }
  return 'Не удалось приложить файл';
};

export interface IMemoUploadSummary {
  added: string[];
  /** Этот файл уже был приложен к записи — дубль не создан. */
  duplicates: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * Загружает файлы ПОСЛЕДОВАТЕЛЬНО. Каждый файл — отдельная операция: сбой одного
 * не отменяет остальные, а повтор безопасен (сервер сравнивает содержимое).
 */
export async function uploadMemoFiles(entryId: string, files: readonly File[]): Promise<IMemoUploadSummary> {
  const summary: IMemoUploadSummary = { added: [], duplicates: [], failed: [] };
  for (const file of files) {
    if (file.size > MEMO_MAX_BYTES) {
      summary.failed.push({ name: file.name, error: 'Файл больше 25 МБ' });
      continue;
    }
    try {
      const { created } = await adminService.uploadBlacklistMemo(entryId, file);
      (created ? summary.added : summary.duplicates).push(file.name);
    } catch (error) {
      summary.failed.push({ name: file.name, error: memoErrorText(error) });
    }
  }
  return summary;
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};
