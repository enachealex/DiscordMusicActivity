// Copies a built APK to server/downloads/ so the website can serve it from
// /download/android. Run after assembleDebug / assembleRelease.
//   npm run publish:apk            # debug build
//   npm run publish:apk -- release # release build
import { copyFile, mkdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] === 'release' ? 'release' : 'debug';

const source = join(here, '..', 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
const destDir = join(here, '..', '..', 'server', 'downloads');
const dest = join(destDir, 'JumpVaultMusic.apk');

try {
  await stat(source);
} catch {
  console.error(`No ${variant} APK at:\n  ${source}\n\nBuild it first:  cd mobile/android && ./gradlew assemble${variant[0].toUpperCase()}${variant.slice(1)}`);
  process.exit(1);
}

await mkdir(destDir, { recursive: true });
await copyFile(source, dest);

const { size } = await stat(dest);
console.log(`Published ${variant} APK -> server/downloads/JumpVaultMusic.apk (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('Commit it and deploy the server for the download link to go live.');
