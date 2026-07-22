const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// esbuild bundles sql.js's JS glue into dist/extension.js but can't inline its .wasm binary —
// copy it alongside so rtkDb.ts's `locateFile: (file) => path.join(__dirname, file)` finds it
// at runtime (bundled CJS output's __dirname resolves to this same dist/ directory).
function copySqlJsWasm() {
  const src = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const destDir = path.join(__dirname, 'dist');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'sql-wasm.wasm'));
}

async function main() {
  copySqlJsWasm();
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
