import { apiClient } from '../api/client';

export type DocumentCategory = 'certificate' | 'scan' | 'approval' | 'payslip' | 'patent_check' | 'other' | 'leave_request_attachment';

export type RecognitionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'needs_review';

export interface IDocument {
  id: number;
  employee_id: number;
  leave_request_id: number | null;
  category: DocumentCategory;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
  recognition_status?: RecognitionStatus | null;
  recognition_attempts?: number | null;
  recognized_at?: string | null;
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  certificate: 'Справка',
  scan: 'Скан',
  approval: 'Подтверждение',
  payslip: 'Расчётный листок',
  patent_check: 'Чек от патента',
  other: 'Другое',
  leave_request_attachment: 'Вложение к заявлению',
};

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const documentService = {
  getMy: async () => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>('/documents/my');
    return res.data;
  },

  getByEmployee: async (empId: number) => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>(`/documents/employee/${empId}`);
    return res.data;
  },

  getByLeaveRequest: async (leaveRequestId: number) => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>(`/documents/leave-request/${leaveRequestId}`);
    return res.data;
  },

  getDownloadUrl: async (id: number) => {
    const res = await apiClient.get<ApiResponse<{ download_url: string; file_name: string }>>(`/documents/${id}/download`);
    return res.data;
  },

  remove: async (id: number) => {
    await apiClient.delete(`/documents/${id}`);
  },

  /** Загрузка файла через бэкенд (multipart) */
  uploadFile: async (file: File, employeeId: number, category: DocumentCategory, leaveRequestId?: number) => {
    const form = new FormData();
    form.append('file', file);
    form.append('employee_id', String(employeeId));
    form.append('category', category);
    if (leaveRequestId) form.append('leave_request_id', String(leaveRequestId));
    const res = await apiClient.post<ApiResponse<IDocument>>('/documents/upload', form);
    return res.data;
  },
};
