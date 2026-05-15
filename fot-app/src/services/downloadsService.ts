import { apiClient } from '../api/client';

interface IDownloadUrlResponse {
  success: boolean;
  data: {
    download_url: string;
    file_name: string;
  };
}

export const downloadsService = {
  async getSigurReaderDriverUrl(): Promise<{ download_url: string; file_name: string }> {
    const res = await apiClient.get<IDownloadUrlResponse>('/downloads/sigur-reader-driver');
    return res.data;
  },
};
