import { apiClient } from '../api/client';

export type DocumentCategory = 'certificate' | 'scan' | 'approval' | 'payslip' | 'patent_check' | 'other' | 'leave_request_attachment' | 'attendance_correction';

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
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  certificate: 'Справка',
  scan: 'Скан',
  approval: 'Подтверждение',
  payslip: 'Расчётный листок',
  patent_check: 'Чек от патента',
  other: 'Другое',
  leave_request_attachment: 'Вложение к заявлению',
  attendance_correction: 'Подтверждение корректировки табеля',
};

interface ApiResponse<T> {
  data: T;
  message?: string;
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
      upload_headers: Record<string, string>;
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

  getByLeaveRequest: async (leaveRequestId: number) => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>(`/documents/leave-request/${leaveRequestId}`);
    return res.data;
  },

  getByAttendanceAdjustment: async (adjustmentId: number) => {
    const res = await apiClient.get<ApiResponse<IDocument[]>>(`/documents/attendance-adjustment/${adjustmentId}`);
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
    const { upload_url, upload_headers, r2_key } = await documentService.getUploadUrl({
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
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...(upload_headers || {}),
      },
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
