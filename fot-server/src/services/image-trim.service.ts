import sharp from 'sharp';
import * as Sentry from '@sentry/node';

const MIN_BYTES = 5 * 1024;
const MIN_DIMENSION = 100;
const TRIM_THRESHOLD = 30;

interface ITrimResult {
  buffer: Buffer;
  size: number;
  mimeType: string;
}

export const trimWhiteBorders = async (
  buffer: Buffer,
  mimeType: string,
): Promise<ITrimResult> => {
  if (!mimeType.startsWith('image/')) {
    return { buffer, size: buffer.length, mimeType };
  }

  const originalSize = buffer.length;

  try {
    const trimmedBuffer = await sharp(buffer)
      .rotate()
      .flatten({ background: '#ffffff' })
      .trim({ threshold: TRIM_THRESHOLD })
      .toBuffer();

    if (trimmedBuffer.length < MIN_BYTES) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'trim result below MIN_BYTES, fallback to original',
        data: { originalSize, trimmedSize: trimmedBuffer.length, mimeType },
        level: 'warning',
      });
      return { buffer, size: originalSize, mimeType };
    }

    const meta = await sharp(trimmedBuffer).metadata();
    if ((meta.width ?? 0) < MIN_DIMENSION || (meta.height ?? 0) < MIN_DIMENSION) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'trim result below MIN_DIMENSION, fallback to original',
        data: { width: meta.width, height: meta.height, mimeType },
        level: 'warning',
      });
      return { buffer, size: originalSize, mimeType };
    }

    const reductionRatio = 1 - trimmedBuffer.length / originalSize;
    if (reductionRatio < 0.01) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'trim ineffective (< 1% reduction)',
        data: { originalSize, trimmedSize: trimmedBuffer.length, reductionRatio, mimeType },
        level: 'info',
      });
    }

    return { buffer: trimmedBuffer, size: trimmedBuffer.length, mimeType };
  } catch (err) {
    console.error('[image-trim] failed, falling back to original:', err);
    Sentry.captureException(err, {
      tags: { service: 'image-trim' },
      extra: { mimeType, byteLength: originalSize },
    });
    return { buffer, size: originalSize, mimeType };
  }
};
