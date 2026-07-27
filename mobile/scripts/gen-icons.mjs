// Rasterises assets/vinyl.svg into every icon the project needs:
//   - the source images @capacitor/assets turns into Android res/ drawables
//   - the PWA icons the website serves, so an iPhone "Add to Home Screen" and
//     the Android launcher end up with the same mark
// Run with: npm run icons
import sharp from 'sharp';
import { readFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
const webPublic = join(here, '..', '..', 'client', 'public');
const BG = '#1e1f22';

const vinyl = await readFile(join(assets, 'vinyl.svg'));

// Renders the vinyl at `scale` of the canvas, optionally over the app background.
async function compose(size, scale, background, outPath) {
  const mark = await sharp(vinyl, { density: 600 })
    .resize(Math.round(size * scale), Math.round(size * scale))
    .png()
    .toBuffer();

  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  await canvas.composite([{ input: mark, gravity: 'center' }]).png().toFile(outPath);
  console.log(`  ${outPath.replace(join(here, '..', '..'), '.')}  ${size}x${size}`);
}

async function solid(size, outPath) {
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .png()
    .toFile(outPath);
  console.log(`  ${outPath.replace(join(here, '..', '..'), '.')}  ${size}x${size}`);
}

await mkdir(assets, { recursive: true });
await mkdir(webPublic, { recursive: true });

console.log('Android icon + splash sources:');
// Legacy square icon — mark nearly full-bleed on the app background.
await compose(1024, 0.86, BG, join(assets, 'icon.png'));
// Adaptive icon: the foreground must stay inside the 66% safe zone or the
// launcher's circular/squircle mask clips it.
await compose(1024, 0.6, null, join(assets, 'icon-foreground.png'));
await solid(1024, join(assets, 'icon-background.png'));
// Splash screens (light + dark are the same — the app is dark-only).
await compose(2732, 0.22, BG, join(assets, 'splash.png'));
await compose(2732, 0.22, BG, join(assets, 'splash-dark.png'));

console.log('PWA icons (client/public):');
await compose(192, 0.86, BG, join(webPublic, 'icon-192.png'));
await compose(512, 0.86, BG, join(webPublic, 'icon-512.png'));
// Maskable icons get cropped to a platform-chosen shape; keep the mark inside
// the 80% safe zone so nothing important is shaved off.
await compose(512, 0.6, BG, join(webPublic, 'icon-512-maskable.png'));
// iOS ignores the manifest icons for Add to Home Screen and uses this one. It
// must be opaque — iOS composites transparency onto black.
await compose(180, 0.86, BG, join(webPublic, 'apple-touch-icon.png'));

console.log('Done.');
