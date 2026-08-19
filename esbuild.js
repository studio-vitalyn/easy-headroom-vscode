const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// `vsce package` always runs `vscode:prepublish` (i.e. `--production`), so a locally installed
// vsix would otherwise be indistinguishable from a published one. EH_DEV_BUILD=1 overrides the
// flag back to a dev build — that's what `npm run package:dev` sets; publish-vscode.sh never does.
const production = process.argv.includes('--production') && process.env.EH_DEV_BUILD !== '1';
const watch = process.argv.includes('--watch');

// package.json's version is always a plain x.y.z — a "-dev" suffix must never reach a commit or a
// published artifact. It's appended here instead, only for a non-production build, so a locally
// built extension host identifies itself as such in the status bar tooltip. See buildInfo.ts.
const extensionVersion = require('./package.json').version + (production ? '' : '-dev');

// esbuild bundles sql.js's JS glue into dist/extension.js but can't inline its .wasm binary —
// copy it alongside so rtkDb.ts's `locateFile: (file) => path.join(__dirname, file)` finds it
// at runtime (bundled CJS output's __dirname resolves to this same dist/ directory).
function copySqlJsWasm() {
  const src = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const destDir = path.join(__dirname, 'dist');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'sql-wasm.wasm'));
}

// carbonFootprint.ts reads this via `path.join(__dirname, file)`, same reasoning as the wasm copy
// above — bundled CJS output's __dirname resolves to dist/ at runtime.
function copyCarbonCoefficients() {
  const src = path.join(__dirname, 'resources', 'carbon-coefficients.json');
  const destDir = path.join(__dirname, 'dist');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'carbon-coefficients.json'));
}

async function main() {
  copySqlJsWasm();
  copyCarbonCoefficients();
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
    define: { __EXT_VERSION__: JSON.stringify(extensionVersion) },
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
