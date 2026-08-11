/** Injected by esbuild's `define` — see the `extensionVersion` computation in esbuild.js. */
declare const __EXT_VERSION__: string;

/**
 * The version this build identifies itself as. Same as package.json's for a production build
 * (`npm run package`, what vsce packages), with a `-dev` suffix for a local one (`npm run
 * compile`/`watch`, what F5 runs) — the suffix lives here rather than in package.json so it can
 * never end up in a commit or in a published vsix.
 */
export const EXTENSION_VERSION = __EXT_VERSION__;
