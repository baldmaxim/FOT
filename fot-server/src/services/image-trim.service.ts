import sharp from 'sharp';
import * as Sentry from '@sentry/node';

const MIN_BYTES = 5 * 1024;
const MIN_DIMENSION = 100;
const TRIM_THRESHOLD = 50;
const MIN_TRIM_PIXELS = 20;

interface ITrimResult {
  buffer: Buffer;
  size: number;
  mimeType: string;
}

interface ITrimAttempt {
  buffer: Buffer;
  width: number;
  height: number;
  deltaPx: number;
  method: 'explicit-white' | 'top-left';
}

const runTrim = async (
  buffer: Buffer,
  method: ITrimAttempt['method'],
): Promise<ITrimAttempt | null> => {
  const pipeline = sharp(buffer).rotate().flatten({ background: '#ffffff' });
  const trimmed = method === 'explicit-white'
    ? await pipeline.trim({ background: '#ffffff', threshold: TRIM_THRESHOLD }).toBuffer()
    : await pipeline.trim({ threshold: TRIM_THRESHOLD }).toBuffer();
  const meta = await sharp(trimmed).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;
  return { buffer: trimmed, width, height, deltaPx: 0, method };
};

export const trimWhiteBorders = async (
  buffer: Buffer,
  mimeType: string,
): Promise<ITrimResult> => {
  if (!mimeType.startsWith('image/')) {
    return { buffer, size: buffer.length, mimeType };
  }

  const originalSize = buffer.length;

  try {
    const origMeta = await sharp(buffer).metadata();
    const origW = origMeta.width ?? 0;
    const origH = origMeta.height ?? 0;
    if (!origW || !origH) {
      return { buffer, size: originalSize, mimeType };
    }

    const attempts: ITrimAttempt[] = [];
    for (const method of ['explicit-white', 'top-left'] as const) {
      try {
        const attempt = await runTrim(buffer, method);
        if (attempt) {
          attempt.deltaPx = (origW - attempt.width) + (origH - attempt.height);
          attempts.push(attempt);
        }
      } catch (err) {
        Sentry.addBreadcrumb({
          category: 'image-trim',
          message: `trim attempt "${method}" threw, skipping`,
          data: { error: String(err), mimeType },
          level: 'warning',
        });
      }
    }

    if (attempts.length === 0) {
      return { buffer, size: originalSize, mimeType };
    }

    const winner = attempts.reduce((best, cur) => (cur.deltaPx > best.deltaPx ? cur : best));

    if (winner.deltaPx < MIN_TRIM_PIXELS) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'no attempt produced meaningful crop, fallback to original',
        data: {
          origW, origH,
          attempts: attempts.map((a) => ({ method: a.method, w: a.width, h: a.height, deltaPx: a.deltaPx })),
          mimeType,
        },
        level: 'info',
      });
      return { buffer, size: originalSize, mimeType };
    }

    if (winner.buffer.length < MIN_BYTES) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'trim result below MIN_BYTES, fallback to original',
        data: { originalSize, trimmedSize: winner.buffer.length, mimeType },
        level: 'warning',
      });
      return { buffer, size: originalSize, mimeType };
    }

    if (winner.width < MIN_DIMENSION || winner.height < MIN_DIMENSION) {
      Sentry.addBreadcrumb({
        category: 'image-trim',
        message: 'trim result below MIN_DIMENSION, fallback to original',
        data: { width: winner.width, height: winner.height, mimeType },
        level: 'warning',
      });
      return { buffer, size: originalSize, mimeType };
    }

    Sentry.addBreadcrumb({
      category: 'image-trim',
      message: `trimmed (${winner.method})`,
      data: {
        origW, origH, trimW: winner.width, trimH: winner.height,
        deltaPx: winner.deltaPx, originalSize, trimmedSize: winner.buffer.length, mimeType,
      },
      level: 'info',
    });

    return { buffer: winner.buffer, size: winner.buffer.length, mimeType };
  } catch (err) {
    console.error('[image-trim] failed, falling back to original:', err);
    Sentry.captureException(err, {
      tags: { service: 'image-trim' },
      extra: { mimeType, byteLength: originalSize },
    });
    return { buffer, size: originalSize, mimeType };
  }
};
