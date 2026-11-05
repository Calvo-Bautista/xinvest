/**
 * Build para Vercel con la Build Output API v3 (https://vercel.com/docs/build-output-api):
 *   .vercel/output/static/           ← SPA (Vite)
 *   .vercel/output/functions/api.func ← API Hono empaquetada con esbuild
 *   .vercel/output/config.json       ← rutas: estáticos → /api → fallback SPA
 * Si DATABASE_URL apunta a Turso, aplica las migraciones pendientes antes.
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel/output');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });

// 1. Migraciones (sólo contra una DB remota; en local se migran al levantar dev)
const dbUrl = process.env.DATABASE_URL ?? '';
if (dbUrl.startsWith('libsql://') || dbUrl.startsWith('https://')) {
  console.log('→ Aplicando migraciones en Turso');
  run('npm run db:migrate');
} else {
  console.log('→ DATABASE_URL no es remota: salteo migraciones');
}

// 2. Frontend
console.log('→ Build de la SPA');
run('npm run build -w @xinvest/web');
cpSync(join(root, 'apps/web/dist'), join(out, 'static'), { recursive: true });

// 3. API como función Node
console.log('→ Bundle de la API');
const fnDir = join(out, 'functions/api.func');
mkdirSync(fnDir, { recursive: true });
await build({
  entryPoints: [join(root, 'apps/server/src/vercel.ts')],
  outfile: join(fnDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  // CommonJS: es el formato que el launcher Node de Vercel carga sin sorpresas.
  format: 'cjs',
  minify: false,
  sourcemap: 'linked',
  // El launcher busca el handler en module.exports; esbuild lo deja en .default.
  footer: { js: 'module.exports = module.exports.default;' },
  logLevel: 'warning',
});
writeFileSync(
  join(fnDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      maxDuration: 30,
    },
    null,
    2,
  ),
);
writeFileSync(join(fnDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));

// 4. Rutas
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: '^/assets/(.*)$',
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '^/api(?:/.*)?$', dest: '/api' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log('✓ Build listo en .vercel/output');
