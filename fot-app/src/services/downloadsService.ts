import { apiClient } from '../api/client';

interface IDownloadUrlResponse {
  success: boolean;
  data: {
    download_url: string;
    file_name: string;
  };
}

interface IUploadResponse {
  success: boolean;
  data: { size: number; key: string };
}

export const downloadsService = {
  async getSigurReaderDriverUrl(): Promise<{ download_url: string; file_name: string }> {
    const res = await apiClient.get<IDownloadUrlResponse>('/downloads/sigur-reader-driver');
    return res.data;
  },

  async uploadSigurReaderDriver(file: File): Promise<{ size: number; key: string }> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<IUploadResponse>('/downloads/sigur-reader-driver', formData);
    return res.data;
  },
};
