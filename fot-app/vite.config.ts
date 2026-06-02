import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryOrg = process.env.SENTRY_ORG
const sentryProject = process.env.SENTRY_PROJECT || 'fot-app'
const sentryRelease = process.env.VITE_SENTRY_RELEASE

// Уникальный идентификатор сборки: один на билд, зашивается в бандл (__BUILD_ID__)
// и эмитится в dist/version.json. Рантайм-хук useVersionCheck сверяет их и
// предлагает перезагрузку, если открытая вкладка работает на устаревшем бандле.
const BUILD_ID = process.env.VITE_SENTRY_RELEASE || new Date().toISOString()

// Кладёт dist/version.json рядом с index.html.
const versionFilePlugin = (): Plugin => ({
  name: 'fot-version-file',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId: BUILD_ID }),
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Загружает sourcemaps в Sentry и удаляет .map из dist/, чтобы они не попали в nginx.
    // Активируется только когда переданы и токен, и org — иначе локальная сборка не падает.
    sentryAuthToken && sentryOrg
      ? sentryVitePlugin({
          org: sentryOrg,
          project: sentryProject,
          authToken: sentryAuthToken,
          release: sentryRelease ? { name: sentryRelease } : undefined,
          sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
        })
      : null,
    versionFilePlugin(),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-router') || id.includes('react-router-dom'))
              return 'vendor-router'
            if (id.includes('lucide-react'))
              return 'vendor-icons'
            if (id.includes('exceljs'))
              return 'vendor-exceljs'
            if (id.includes('react-dom') || id.includes('/react/'))
              return 'vendor-react'
          }
        },
      },
    },
  },
})
