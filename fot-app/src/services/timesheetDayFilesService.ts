import { apiClient } from '../api/client';

/** Файл дня табеля (кадровый админ, без корректировки). */
export interface ITimesheetDayFile {
  id: number;
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

export const timesheetDayFilesService = {
  async list(employeeId: number, workDate: string): Promise<ITimesheetDayFile[]> {
    const params = new URLSearchParams({ employee_id: String(employeeId), work_date: workDate });
    const res = await apiClient.get<IApiResponse<ITimesheetDayFile[]>>(`/timesheet/day-files?${params.toString()}`);
    if (!res.data) throw new Error(res.error || 'Ошибка получения файлов дня');
    return res.data;
  },

  async upload(employeeId: number, workDate: string, file: File): Promise<ITimesheetDayFile> {
    const formData = new FormData();
    // Поля формы — до файла: multer видит их в req.body к моменту обработки.
    formData.append('employee_id', String(employeeId));
    formData.append('work_date', workDate);
    formData.append('file', file);
    const res = await apiClient.request<IApiResponse<ITimesheetDayFile>>(
      '/timesheet/day-files',
      { method: 'POST', body: formData },
    );
    if (!res.data) throw new Error(res.error || 'Ошибка загрузки файла');
    return res.data;
  },

  async remove(documentId: number): Promise<void> {
    const res = await apiClient.request<IApiResponse<null>>(
      `/timesheet/day-files/${documentId}`,
      { method: 'DELETE' },
    );
    if (res.error) throw new Error(res.error);
  },
};
