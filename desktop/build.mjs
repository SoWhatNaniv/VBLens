// Builds the VBLens desktop app.
//
//   node desktop/build.mjs stage            only prepare build/app (run it with: npx electron build/app)
//   node desktop/build.mjs win32            portable Windows app  -> release/VBLens-Windows-x64.zip
//   node desktop/build.mjs linux            Linux app             -> release/VBLens-linux-x64/
//
// Needs dist/index.html (npm run build) and dist-mcp/vblens-mcp.mjs (npm run build:mcp);
// the npm scripts dist:win / dist:linux run those first. Works on Linux and Windows; the
// Windows exe icon and version info are written with resedit, so no Wine is needed.

import { build } from 'esbuild';
import { packager } from '@electron/packager';
import * as ResEdit from 'resedit';
import { zip } from 'fflate';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const STAGE = path.join(ROOT, 'build', 'app');
const OUT = path.join(ROOT, 'release');
const PRODUCT = 'VBLens';
const COMPANY = process.env.VBLENS_COMPANY || 'VBLens contributors';
const COPYRIGHT = `Copyright © ${new Date().getFullYear()} ${COMPANY}. MIT License.`;
const target = process.argv[2] ?? 'stage';

function need(file, how) {
  if (!existsSync(path.join(ROOT, file))) { console.error(`${file} is missing: run "${how}" first.`); process.exit(1); }
}
need('dist/index.html', 'npm run build');
need('dist-mcp/vblens-mcp.mjs', 'npm run build:mcp');
if (statSync(path.join(ROOT, 'dist-mcp/vblens-mcp.mjs')).mtimeMs < statSync(path.join(ROOT, 'dist/index.html')).mtimeMs - 1000) {
  console.error('warning: dist-mcp/vblens-mcp.mjs is older than dist/index.html — run "npm run build:mcp" so the engine embeds the current app.');
}

// ---- stage: the app folder Electron runs ----------------------------------------------------
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(path.join(STAGE, 'engine'), { recursive: true });
await build({
  entryPoints: [path.join(ROOT, 'desktop', 'main.ts')],
  outfile: path.join(STAGE, 'main.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'warning',
  minify: true,
});
cpSync(path.join(ROOT, 'dist-mcp', 'vblens-mcp.mjs'), path.join(STAGE, 'engine', 'vblens-mcp.mjs'));
cpSync(path.join(ROOT, 'desktop', 'assets', 'icon.png'), path.join(STAGE, 'icon.png'));
writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'vblens', productName: PRODUCT, version: pkg.version, description: 'Visual Basic 5/6 decompiler',
  main: 'main.cjs', author: COMPANY, license: 'MIT', private: true,
}, null, 2));
console.log(`staged ${path.relative(ROOT, STAGE)} (Electron ${electronVersion})`);
if (target === 'stage') process.exit(0);

// ---- package ---------------------------------------------------------------------------------
if (!['win32', 'linux'].includes(target)) { console.error(`unknown target ${target}: use stage, win32 or linux`); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const [dir] = await packager({
  dir: STAGE, out: OUT, overwrite: true, platform: target, arch: 'x64', electronVersion,
  name: 'VBLens', executableName: 'VBLens', appVersion: pkg.version, appCopyright: COPYRIGHT,
  asar: true, prune: false, quiet: true,
  // icon and version info for Windows are written below with resedit (no Wine needed)
});
console.log(`packaged ${path.relative(ROOT, dir)}`);

// Chromium UI translations: the app is in English; keep English and Hebrew only (-~45 MB)
const KEEP_LOCALES = new Set(['en-US.pak', 'en-GB.pak', 'he.pak']);
const locDir = path.join(dir, 'locales');
if (existsSync(locDir)) for (const f of readdirSync(locDir)) if (!KEEP_LOCALES.has(f)) rmSync(path.join(locDir, f));

if (target === 'win32') {
  const exePath = path.join(dir, 'VBLens.exe');
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(readFileSync(path.join(ROOT, 'desktop', 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1, lang = groups[0]?.lang ?? 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: PRODUCT, FileDescription: PRODUCT, CompanyName: COMPANY, LegalCopyright: COPYRIGHT,
    OriginalFilename: 'VBLens.exe', InternalName: 'VBLens', FileVersion: pkg.version, ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('set VBLens.exe icon and version info');
}

cpSync(path.join(ROOT, 'dist-mcp', 'THIRD_PARTY_NOTICES.txt'), path.join(dir, 'THIRD_PARTY_NOTICES.txt'));
cpSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE-VBLens.txt'));

// a short read-me next to the program
writeFileSync(path.join(dir, 'README.txt'), [
  `${PRODUCT} ${pkg.version}`,
  '',
  `Start ${target === 'win32' ? 'VBLens.exe' : './VBLens'}. Drop a Visual Basic 5/6 .exe, .dll or .ocx on the window`,
  `(or on ${target === 'win32' ? 'VBLens.exe' : 'the program'}) to analyse it. Files are only read, never run.`,
  '',
  'Everything is free: decompiled VB source, code search, project export and',
  'AI agent access over MCP (top bar → AI agent).',
  '',
  'Free and open source: https://github.com/SoWhatNaniv/VBLens',
  '',
  'Settings and logs are kept in',
  target === 'win32' ? '  %APPDATA%\\VBLens' : '  ~/.config/VBLens',
  '',
  COPYRIGHT,
].join(target === 'win32' ? '\r\n' : '\n'));

if (target === 'win32') {
  // one portable zip with a top-level "VBLens" folder
  const files = {};
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = path.join(abs, name), r = rel ? `${rel}/${name}` : name;
      if (statSync(a).isDirectory()) walk(a, r); else files[`VBLens/${r}`] = [readFileSync(a), { level: /\.(pak|dat|bin|asar|exe|dll|node)$/i.test(name) ? 6 : 9 }];
    }
  };
  walk(dir, '');
  const zipped = await new Promise((resolve, reject) => zip(files, { level: 6 }, (e, d) => (e ? reject(e) : resolve(d))));
  const zipPath = path.join(OUT, `VBLens-Windows-x64-${pkg.version}.zip`);
  writeFileSync(zipPath, zipped);
  console.log(`wrote ${path.relative(ROOT, zipPath)} (${(zipped.length / 1048576).toFixed(0)} MB)`);
}
