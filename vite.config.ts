import { defineConfig } from 'vitest/config';

// 相対パスで出力し、GitHub Pages のサブパス（/<repo>/）でもそのまま動くようにする
export default defineConfig({
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
