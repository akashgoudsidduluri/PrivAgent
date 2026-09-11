import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig({
  base: './',
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        contentScript: resolve(__dirname, 'src/content/contentScript.ts'),
        serviceWorker: resolve(__dirname, 'src/background/serviceWorker.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'contentScript') return 'contentScript.js';
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
  plugins: [
    {
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
      },
    },
  ],
});
