import { apiClient } from '../api/client';

export interface ICorrectionAttachment {
  id: number;
  source: 'adjustment' | 'leave_request';
  original_name: string;
  mime_type: string | null;
  file_size: number;
  uploaded_at: string;
  uploader_name: string | null;
  download_url: string;
  preview_url: string;
}

interface IApiResponse<T> {
  data?: T;
  error?: string;
}

export const correctionAttachmentsService = {
  async list(adjustmentId: number): Promise<ICorrectionAttachment[]> {
    const res = await apiClient.get<IApiResponse<ICorrectionAttachment[]>>(
      `/timesheet/corrections/${adjustmentId}/attachments`,
    );
    if (!res.data) throw new Error(res.error || 'Ошибка получения файлов');
    return res.data;
  },

  async upload(adjustmentId: number, file: File): Promise<ICorrectionAttachment> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.request<IApiResponse<ICorrectionAttachment>>(
      `/timesheet/corrections/${adjustmentId}/attachments`,
      { method: 'POST', body: formData },
    );
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки файла');
    return res.data;
  },

  /** Один файл → один документ → ссылки на все корректировки (дни) одного сотрудника. */
  async uploadBulk(adjustmentIds: number[], file: File): Promise<ICorrectionAttachment> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('adjustment_ids', JSON.stringify(adjustmentIds));
    const res = await apiClient.request<IApiResponse<ICorrectionAttachment>>(
      '/timesheet/corrections/attachments/bulk',
      { method: 'POST', body: formData },
    );
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки файла');
    return res.data;
  },

  async remove(adjustmentId: number, attachmentId: number): Promise<void> {
    const res = await apiClient.request<IApiResponse<null>>(
      `/timesheet/corrections/${adjustmentId}/attachments/${attachmentId}`,
      { method: 'DELETE' },
    );
    if (res.error) throw new Error(res.error);
  },
};

/**
 * Прикрепляет общие файлы к массовой корректировке: для каждого файла группирует
 * adjustment_id по employee_id и грузит ОДИН общий документ на сотрудника (а не копию
 * на каждый день). Возвращает число неудачных загрузок (по парам сотрудник × файл).
 */
export const uploadSharedCorrectionFiles = async (
  items: Array<{ adjustment_id: number | null; employee_id: number }>,
  files: File[],
): Promise<{ failed: number }> => {
  if (files.length === 0) return { failed: 0 };

  const byEmployee = new Map<number, number[]>();
  for (const item of items) {
    if (item.adjustment_id == null) continue;
    const list = byEmployee.get(item.employee_id) ?? [];
    list.push(item.adjustment_id);
    byEmployee.set(item.employee_id, list);
  }
  const groups = [...byEmployee.values()];
  if (groups.length === 0) return { failed: 0 };

  const tasks = files.flatMap(file =>
    groups.map(adjustmentIds => correctionAttachmentsService.uploadBulk(adjustmentIds, file)),
  );
  const results = await Promise.allSettled(tasks);
  return { failed: results.filter(r => r.status === 'rejected').length };
};
