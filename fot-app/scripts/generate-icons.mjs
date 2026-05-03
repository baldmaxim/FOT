// Одноразовый скрипт: рендерит PNG-иконки из public/fot-favicon-32.svg
// для apple-touch-icon (iOS) и manifest.json (Android/PWA).
// Запуск: npm run icons:generate
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const svgPath = join(publicDir, 'fot-favicon-32.svg');
const svg = await readFile(svgPath);

const targets = [
  { name: 'apple-touch-icon-120.png', size: 120 },
  { name: 'apple-touch-icon-152.png', size: 152 },
  { name: 'apple-touch-icon-167.png', size: 167 },
  { name: 'apple-touch-icon-180.png', size: 180 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
];

for (const { name, size } of targets) {
  // density задаётся в DPI; SVG имеет viewBox 64x64 → density = size * 72 / 64
  // округляем вверх для запаса.
  const density = Math.ceil((size * 72) / 64) * 2;
  await sharp(svg, { density })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 9, g: 9, b: 11, alpha: 1 },
    })
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, name));
  console.log(`✓ ${name} (${size}×${size})`);
}
