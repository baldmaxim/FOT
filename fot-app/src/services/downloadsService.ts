import { apiClient } from '../api/client';

interface IDownloadUrlResponse {
  success: boolean;
  data: {
    download_url: string;
    file_name: string;
  };
}

interface IUploadUrlResponse {
  success: boolean;
  data: {
    url: string;
    headers: Record<string, string>;
    key: string;
  };
}

export const downloadsService = {
  async getSigurReaderDriverUrl(): Promise<{ download_url: string; file_name: string }> {
    const res = await apiClient.get<IDownloadUrlResponse>('/downloads/sigur-reader-driver');
    return res.data;
  },

  /**
   * Загрузка драйвера в R2 двумя шагами:
   * 1. Бэк отдаёт presigned PUT-URL (минуем nginx body-limit).
   * 2. Браузер PUT'ом льёт файл прямо в R2 — CORS уже разрешает PUT с прода и localhost.
   */
  async uploadSigurReaderDriver(file: File): Promise<{ size: number }> {
    const presign = await apiClient.get<IUploadUrlResponse>('/downloads/sigur-reader-driver/upload-url');
    const { url, headers } = presign.data;

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body: file,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`R2 ответил ${res.status}: ${text || res.statusText}`);
    }
    return { size: file.size };
  },
};
