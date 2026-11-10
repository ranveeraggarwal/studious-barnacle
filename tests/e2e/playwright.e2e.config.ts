import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 720 },
    hasTouch: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      executablePath: '/usr/lib/chromium/chromium',
      args: [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  projects: [
    {
      name: 'chromium-webgl',
      use: {
        browserName: 'chromium',
      },
    },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    cwd: '../..',
    env: { CI: '1' },
    reuseExistingServer: true,
    timeout: 30000,
  },
});
