import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
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
