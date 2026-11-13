import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStateDir } from '../src/index.ts'

/**
 * `stateDir` 的三档解析。
 *
 * 第二档（继承 orchestrator 的 machine.stateDir）是 bundle 自动挂载能工作的前提：
 * 包内 patch 不能写死绝对路径，用户也不会去读 README 第 3 步。
 */

test('显式配置优先于 orchestrator', () => {
  const resolved = resolveStateDir(
    { stateDir: '/explicit/state' },
    { machine: { stateDir: '/from/orchestrator' } },
  )
  assert.deepEqual(resolved, { stateDir: '/explicit/state', origin: 'config' })
})

test('没有配置时继承 orchestrator 的 machine.stateDir', () => {
  const resolved = resolveStateDir(undefined, { machine: { stateDir: '/from/orchestrator' } })
  assert.deepEqual(resolved, { stateDir: '/from/orchestrator', origin: 'orchestrator' })
})

test('两处都拿不到时是 none，而不是猜一个目录', () => {
  assert.deepEqual(resolveStateDir(undefined, undefined), { stateDir: '', origin: 'none' })
  assert.deepEqual(resolveStateDir({}, {}), { stateDir: '', origin: 'none' })
  // 形状不对的 orchestrator 不能把插件带进一个错误的目录
  assert.deepEqual(resolveStateDir(undefined, { machine: { stateDir: 42 } }), { stateDir: '', origin: 'none' })
})

test('空白字符串不算配置，退回下一档', () => {
  assert.deepEqual(
    resolveStateDir({ stateDir: '   ' }, { machine: { stateDir: '/from/orchestrator' } }),
    { stateDir: '/from/orchestrator', origin: 'orchestrator' },
  )
  assert.deepEqual(resolveStateDir({ stateDir: '' }, undefined), { stateDir: '', origin: 'none' })
})

test('两端空白会被去掉：路径带尾随空格会读到不存在的目录', () => {
  assert.deepEqual(
    resolveStateDir({ stateDir: '  /state  ' }, undefined),
    { stateDir: '/state', origin: 'config' },
  )
})

test('继承路径原样保留：上游拼路径不 trim，我们也不能', () => {
  // 上游用 join(machine.stateDir, 'orchestrator.sqlite')，把空格也算进目录名。
  // 这里若 trim，两边就会指向不同目录，而 readOnly 打开失败只会表现为「没有数据」。
  assert.deepEqual(
    resolveStateDir(undefined, { machine: { stateDir: '/from/orchestrator  ' } }),
    { stateDir: '/from/orchestrator  ', origin: 'orchestrator' },
  )
})

test('全空白的继承值仍算没有，而不是一个空格目录', () => {
  assert.deepEqual(resolveStateDir(undefined, { machine: { stateDir: '   ' } }), { stateDir: '', origin: 'none' })
})
