/// <reference types="vite-plugin-electron/electron-env" />

import type { AlbumApi } from '../shared/types'

declare global {
  interface Window {
    api: AlbumApi
  }

  namespace NodeJS {
    interface ProcessEnv {
      /**
       * The built directory structure
       *
       * ```tree
       * ├─┬─┬ dist
       * │ │ └── index.html
       * │ │
       * │ ├─┬ dist-electron
       * │ │ ├── main.js
       * │ │ └── preload.js
       * │
       * ```
       */
      APP_ROOT: string
      /** /dist/ or /public/ */
      VITE_PUBLIC: string
    }
  }
}

export {}
