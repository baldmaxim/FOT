import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { trimWhiteBorders } from './image-trim.service.js';

const PNG = 'image/png';

const buildImage = async (
  width: number,
  height: number,
  paint: (rgba: Buffer) => void,
): Promise<Buffer> => {
  const channels = 4;
  const raw = Buffer.alloc(width * height * channels, 0xff);
  for (let i = 3; i < raw.length; i += channels) raw[i] = 0xff;
  paint(raw);
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
};

const fillRect = (
  rgba: Buffer,
  imgW: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): void => {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const idx = (row * imgW + col) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 0xff;
    }
  }
};

const fillNoiseRect = (
  rgba: Buffer,
  imgW: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  let seed = 0x1234;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const idx = (row * imgW + col) * 4;
      rgba[idx] = rand() & 0x7f;
      rgba[idx + 1] = rand() & 0x7f;
      rgba[idx + 2] = rand() & 0x7f;
      rgba[idx + 3] = 0xff;
    }
  }
};

describe('trimWhiteBorders', () => {
  it('crops white borders down to the noisy content', async () => {
    const orig = await buildImage(600, 400, (rgba) => {
      fillNoiseRect(rgba, 600, 200, 100, 200, 200);
    });
    const origMeta = await sharp(orig).metadata();
    expect(origMeta.width).toBe(600);
    expect(origMeta.height).toBe(400);

    const trimmed = await trimWhiteBorders(orig, PNG);
    const meta = await sharp(trimmed.buffer).metadata();
    expect(meta.width).toBeLessThan(220);
    expect(meta.height).toBeLessThan(220);
    expect(meta.width).toBeGreaterThanOrEqual(180);
    expect(meta.height).toBeGreaterThanOrEqual(180);
  });

  it('crops even when top-left pixel is off-white (vignette)', async () => {
    const orig = await buildImage(600, 400, (rgba) => {
      fillRect(rgba, 600, 0, 0, 1, 1, 0xed, 0xed, 0xed);
      fillNoiseRect(rgba, 600, 200, 100, 200, 200);
    });
    const trimmed = await trimWhiteBorders(orig, PNG);
    const meta = await sharp(trimmed.buffer).metadata();
    expect(meta.width).toBeLessThan(260);
    expect(meta.height).toBeLessThan(260);
  });

  it('returns the original when there is no white border to trim', async () => {
    const orig = await buildImage(600, 400, (rgba) => {
      fillNoiseRect(rgba, 600, 0, 0, 600, 400);
    });
    const trimmed = await trimWhiteBorders(orig, PNG);
    expect(trimmed.buffer).toBe(orig);
    expect(trimmed.size).toBe(orig.length);
  });

  it('passes non-image mime types through unchanged', async () => {
    const buf = Buffer.from('not an image');
    const result = await trimWhiteBorders(buf, 'application/pdf');
    expect(result.buffer).toBe(buf);
    expect(result.size).toBe(buf.length);
    expect(result.mimeType).toBe('application/pdf');
  });
});
