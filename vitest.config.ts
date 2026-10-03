import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // The production UI imports dist, but tests run before build in verify.
    // Exercise current source instead of any stale build left in the checkout.
    alias: [{ find: /^\.\.\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL('./src/$1.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
