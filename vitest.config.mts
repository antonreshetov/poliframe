import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve('src/renderer'), '~': path.resolve('src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    pool: 'forks',
    env: { PANGOCAIRO_BACKEND: 'fontconfig' },
    testTimeout: 15000,
    hookTimeout: 30000,
  },
})
