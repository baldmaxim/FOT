import { apiClient } from '../api/client';

export type DocumentCategory = 'certificate' | 'scan' | 'approval' | 'payslip' | 'other';

export interface IDocument {
  id: number;
  organization_id: string;
  employee_id: number;
  leave_request_id: number | null;
  category: DocumentCategory;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  created_at: string;
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  certificate: 'Справка',
  scan: 'Скан',
  approval: 'Подтверждение',
  payslip: 'Расчётный листок',
  other: 'Другое',
};

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const documentService = {
  getUploadUrl: async (data: {
    employee_id: number;
    file_name: string;
    content_type: string;
    category: DocumentCategory;
    leave_request_id?: number;
  }) => {
    const res = await apiClient.post<ApiResponse<{
      upload_url: string;
      r2_key: string;
      employee_id: number;
      file_name: string;
      content_type: string;
      category: DocumentCategory;
      leave_request_id: number | null;
    }>>('/documents/upload-url', data);
    return res.data;
  },

  confirmUpload: async (data: {
    r2_key: string;
    employee_id: number;
    file_name: string;
    file_size: number;
    mime_type: string;
    category: DocumentCategory;
    leave_request_id?: number;
  }) => {
    const res = await apiClient.post<ApiResponse<IDocument>>('/documents/confirm', data);
    return res.data;
  },

  getMy: async () => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>('/documents/my');
    return res.data;
  },

  getByEmployee: async (empId: number) => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>(`/documents/employee/${empId}`);
    return res.data;
  },

  getDownloadUrl: async (id: number) => {
    const res = await apiClient.get<ApiResponse<{ download_url: string; file_name: string }>>(`/documents/${id}/download`);
    return res.data;
  },

  remove: async (id: number) => {
    await apiClient.delete(`/documents/${id}`);
  },

  /** Загрузить файл через presigned URL */
  uploadFile: async (file: File, employeeId: number, category: DocumentCategory, leaveRequestId?: number) => {
    // 1. Получаем presigned URL
    const { upload_url, r2_key } = await documentService.getUploadUrl({
      employee_id: employeeId,
      file_name: file.name,
      content_type: file.type || 'application/octet-stream',
      category,
      leave_request_id: leaveRequestId,
    });

    // 2. Загружаем файл напрямую в R2
    await fetch(upload_url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });

    // 3. Подтверждаем загрузку
    return documentService.confirmUpload({
      r2_key,
      employee_id: employeeId,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      category,
      leave_request_id: leaveRequestId,
    });
  },
};
