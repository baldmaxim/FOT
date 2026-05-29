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

  async remove(adjustmentId: number, attachmentId: number): Promise<void> {
    const res = await apiClient.request<IApiResponse<null>>(
      `/timesheet/corrections/${adjustmentId}/attachments/${attachmentId}`,
      { method: 'DELETE' },
    );
    if (res.error) throw new Error(res.error);
  },
};
