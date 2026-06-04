import convert from 'heic-convert';
import * as Sentry from '@sentry/node';

// HEIC/HEIF не рендерится в браузерах (кроме Safari) и не поддерживается
// vision-моделью распознавания. Конвертируем в JPEG ещё до загрузки в R2,
// чтобы и превью открывалось inline, и AI-распознавание работало.
// Используем heic-convert (libheif-wasm): sharp в prebuilt-сборке не имеет
// HEVC-декодера и падает с «compression format has not been built in».

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

// Бренды ISO-BMFF (ftyp-box) для HEIC/HEIF.
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx',
  'mif1', 'msf1',
]);

// Детект HEIC по магическим байтам: ...ftyp<brand> в начале файла.
// iOS Safari часто шлёт пустой Content-Type, поэтому полагаться только на
// mimeType/расширение нельзя.
export const isHeicBuffer = (buffer: Buffer): boolean => {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const majorBrand = buffer.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.has(majorBrand);
};

const hasHeicExtension = (fileName: string): boolean =>
  /\.(heic|heif)$/i.test(fileName);

const isHeic = (buffer: Buffer, mimeType: string, fileName: string): boolean =>
  HEIC_MIME_TYPES.has(mimeType.toLowerCase()) ||
  hasHeicExtension(fileName) ||
  isHeicBuffer(buffer);

interface INormalizeResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  size: number;
}

// Приводит изображение к формату, который открывается в браузере inline.
// Сейчас конвертирует только HEIC/HEIF → JPEG; остальные форматы возвращает
// без изменений. При ошибке конвертации возвращает исходный буфер (не валит
// загрузку), логируя в Sentry.
export const ensureBrowserFriendlyImage = async (
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<INormalizeResult> => {
  if (!isHeic(buffer, mimeType, fileName)) {
    return { buffer, mimeType, fileName, size: buffer.length };
  }

  try {
    const out = await convert({ buffer, format: 'JPEG', quality: 0.88 });
    const jpeg = Buffer.from(out);
    const newName = fileName.replace(/\.(heic|heif)$/i, '.jpg');
    const fileName2 = newName === fileName ? `${fileName}.jpg` : newName;
    return { buffer: jpeg, mimeType: 'image/jpeg', fileName: fileName2, size: jpeg.length };
  } catch (err) {
    console.error('[image-normalize] HEIC→JPEG conversion failed, keeping original:', err);
    Sentry.captureException(err, {
      tags: { service: 'image-normalize' },
      extra: { mimeType, fileName, byteLength: buffer.length },
    });
    return { buffer, mimeType, fileName, size: buffer.length };
  }
};
