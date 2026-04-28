import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryOrg = process.env.SENTRY_ORG
const sentryProject = process.env.SENTRY_PROJECT || 'fot-app'
const sentryRelease = process.env.VITE_SENTRY_RELEASE

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
  ],
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
