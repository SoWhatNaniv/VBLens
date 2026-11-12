// Bundles the MCP server into one file, with the app (dist/index.html) embedded so the
// server can host it. Run "npm run build" first.
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const app = 'dist/index.html';
if (!existsSync(app)) {
  console.error(`${app} is missing: run "npm run build" first (the server embeds the app).`);
  process.exit(1);
}
const srcTime = Math.max(...['src/ui', 'src/core'].map(d => statSync(d).mtimeMs));
if (statSync(app).mtimeMs < srcTime - 1000) console.error(`warning: ${app} looks older than src/: run "npm run build" to embed the current app.`);

const result = await build({
  metafile: true,
  entryPoints: ['mcp/server.ts'],
  outfile: 'dist-mcp/vblens-mcp.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'warning',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  define: { __VBLENS_APP_HTML__: JSON.stringify(readFileSync(app, 'utf8')) },
});
// Open-source packages bundled into the engine and the app keep their license texts.
const pkgs = new Set(['react', 'react-dom', 'scheduler', 'fflate']); // in the app (dist/index.html)
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) pkgs.add(m[1]);
}
const notices = [...pkgs].sort().map(name => {
  const dir = path.join('node_modules', name);
  const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lic = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = lic ? readFileSync(path.join(dir, lic), 'utf8').trim() : `License: ${pj.license ?? 'see package'}`;
  return `${name} ${pj.version} (${pj.license ?? 'unknown'})\n${'-'.repeat(60)}\n${text}`;
});
writeFileSync('dist-mcp/THIRD_PARTY_NOTICES.txt', `VBLens includes the following open-source software.\nElectron and Chromium notices are in LICENSE and LICENSES.chromium.html next to the program.\n\n${notices.join('\n\n\n')}\n`);
console.error(`built dist-mcp/vblens-mcp.mjs (${(statSync('dist-mcp/vblens-mcp.mjs').size / 1048576).toFixed(1)} MB, app embedded)`);
