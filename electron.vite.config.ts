import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          dialog: resolve('src/renderer/dialog.html'),
          settings: resolve('src/renderer/settings.html'),
          overlay: resolve('src/renderer/regionOverlay.html')
        }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
