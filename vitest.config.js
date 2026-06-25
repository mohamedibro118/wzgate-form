import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Base the jsdom origin on lp.test so the tests can navigate (replaceState)
    // within the same origin without a SecurityError.
    environmentOptions: { jsdom: { url: 'https://lp.test/' } },
  },
})
