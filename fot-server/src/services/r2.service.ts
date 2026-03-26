import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET_NAME, r2Enabled } from '../config/r2.js';
import { randomUUID } from 'crypto';
import path from 'path';

const URL_EXPIRY = 3600; // 1 час

export const r2Service = {
  isEnabled: () => r2Enabled,

  generateKey: (orgId: string, employeeId: number, fileName: string): string => {
    const ext = path.extname(fileName) || '.bin';
    return `${orgId}/documents/${employeeId}/${randomUUID()}${ext}`;
  },

  generateUploadUrl: async (key: string, contentType: string): Promise<string> => {
    if (!r2Client) throw new Error('R2 не настроен');
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(r2Client, command, { expiresIn: URL_EXPIRY });
  },

  generateDownloadUrl: async (key: string): Promise<string> => {
    if (!r2Client) throw new Error('R2 не настроен');
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });
    return getSignedUrl(r2Client, command, { expiresIn: URL_EXPIRY });
  },

  deleteObject: async (key: string): Promise<void> => {
    if (!r2Client) throw new Error('R2 не настроен');
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });
    await r2Client.send(command);
  },
};
