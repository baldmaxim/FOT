import sharp from 'sharp';

const MIN_BYTES = 5 * 1024;
const MIN_DIMENSION = 100;
const TRIM_THRESHOLD = 25;

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

  try {
    const trimmedBuffer = await sharp(buffer)
      .rotate()
      .trim({ background: '#ffffff', threshold: TRIM_THRESHOLD })
      .toBuffer();

    if (trimmedBuffer.length < MIN_BYTES) {
      return { buffer, size: buffer.length, mimeType };
    }

    const meta = await sharp(trimmedBuffer).metadata();
    if ((meta.width ?? 0) < MIN_DIMENSION || (meta.height ?? 0) < MIN_DIMENSION) {
      return { buffer, size: buffer.length, mimeType };
    }

    return { buffer: trimmedBuffer, size: trimmedBuffer.length, mimeType };
  } catch (err) {
    console.error('[image-trim] failed, falling back to original:', err);
    return { buffer, size: buffer.length, mimeType };
  }
};
