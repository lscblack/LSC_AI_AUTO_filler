import { defineConfig } from 'tsup';

export default defineConfig([
  // background + popup: ESM is fine — background declares "type":"module" in
  // the manifest, popup.html loads popup.js with type="module".
  {
    entry: {
      background: 'src/background.ts',
      popup: 'src/popup.ts'
    },
    format: ['esm'],
    sourcemap: true,
    clean: true,
    // @lsc-ai/shared is a workspace package in node_modules — bundle it in so
    // the extension doesn't need a bare import it can't resolve.
    noExternal: ['@lsc-ai/shared']
  },
  // content-script: must be a classic (non-module) script because the manifest
  // does not declare "type":"module" on content_scripts. IIFE wraps everything
  // in an immediately-invoked function with no import/export statements.
  {
    entry: { 'content-script': 'src/content-script.ts' },
    format: ['iife'],
    // tsup appends ".global.js" for iife by default; strip it so the manifest
    // reference "dist/content-script.js" keeps working.
    outExtension: () => ({ js: '.js' }),
    sourcemap: true,
    clean: false,
    noExternal: ['@lsc-ai/shared']
  }
]);
