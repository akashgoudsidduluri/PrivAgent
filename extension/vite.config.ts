import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

// Shared post-build asset copy plugin
function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');

      // Copy manifest.json
      fs.copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(outDir, 'manifest.json')
      );

      // Copy contentStyles.css
      fs.copyFileSync(
        resolve(__dirname, 'src/content/contentStyles.css'),
        resolve(outDir, 'contentStyles.css')
      );

      // Copy popup.html to root of dist if Vite placed it in src/popup/
      const nestedPopup = resolve(outDir, 'src/popup/popup.html');
      if (fs.existsSync(nestedPopup)) {
        let htmlContent = fs.readFileSync(nestedPopup, 'utf-8');
        htmlContent = htmlContent.replace(/\.\.\/\.\.\/assets\//g, './assets/');
        fs.writeFileSync(resolve(outDir, 'popup.html'), htmlContent, 'utf-8');
      }

      // Copy icons directory
      const iconsSrc = resolve(__dirname, 'public/icons');
      const iconsDest = resolve(outDir, 'icons');
      if (fs.existsSync(iconsSrc)) {
        fs.mkdirSync(iconsDest, { recursive: true });
        fs.readdirSync(iconsSrc).forEach(file => {
          fs.copyFileSync(resolve(iconsSrc, file), resolve(iconsDest, file));
        });
      }

      // Copy local OCR assets (worker, core wasm, traineddata)
      const ocrDest = resolve(outDir, 'assets/ocr');
      fs.mkdirSync(ocrDest, { recursive: true });

      const nodeModules = resolve(__dirname, '../node_modules');
      const ocrFiles = [
        { src: resolve(nodeModules, 'tesseract.js/dist/worker.min.js'), dest: 'worker.min.js' },
        { src: resolve(nodeModules, 'tesseract.js-core/tesseract-core-simd.wasm.js'), dest: 'tesseract-core-simd.wasm.js' },
        { src: resolve(nodeModules, 'tesseract.js-core/tesseract-core-simd.wasm'), dest: 'tesseract-core-simd.wasm' },
        { src: resolve(nodeModules, 'tesseract.js-core/tesseract-core.wasm.js'), dest: 'tesseract-core.wasm.js' },
        { src: resolve(nodeModules, 'tesseract.js-core/tesseract-core.wasm'), dest: 'tesseract-core.wasm' },
        { src: resolve(nodeModules, '@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'), dest: 'eng.traineddata.gz' },
      ];

      for (const file of ocrFiles) {
        if (fs.existsSync(file.src)) {
          fs.copyFileSync(file.src, resolve(ocrDest, file.dest));
        }
      }
    },
  };
}

// Main build: popup + service worker (ESM, with code splitting allowed)
export default defineConfig(({ mode }) => {
  // When building the content script specifically (VITE_BUILD_TARGET=contentScript),
  // produce a self-contained IIFE with no dynamic imports.
  if (process.env.VITE_BUILD_TARGET === 'contentScript') {
    return {
      base: './',
      root: resolve(__dirname),
      build: {
        outDir: resolve(__dirname, 'dist'),
        emptyOutDir: false,   // don't wipe main build
        lib: {
          entry: resolve(__dirname, 'src/content/contentScript.ts'),
          name: 'PrivAgentContentScript',
          formats: ['iife'],
          fileName: () => 'contentScript.js',
        },
        rollupOptions: {
          output: {
            // No code splitting — everything inlined
            inlineDynamicImports: true,
          },
        },
      },
    };
  }

  // Default build: popup HTML + service worker
  return {
    base: './',
    root: resolve(__dirname),
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'src/popup/popup.html'),
          serviceWorker: resolve(__dirname, 'src/background/serviceWorker.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'serviceWorker') return 'serviceWorker.js';
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name === 'popup.html') return 'popup.html';
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
    plugins: [copyExtensionAssets()],
  };
});
