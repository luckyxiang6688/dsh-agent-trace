/**
 * 把隔离页的入口打成一份 IIFE（react 一起打进去），产物落在 tmp/（不进仓）。
 * 用法（仓库 plugin/ 下）：`node node_modules/tsdown/dist/run.mjs -c tests/perf/harness/tsdown.config.ts`
 */
export default {
  entry: { harness: './entry.ts' },
  outDir: '../../../tmp/harness',
  format: 'iife' as const,
  platform: 'browser' as const,
  target: 'es2022',
  dts: false,
  clean: true,
  minify: false,
}
