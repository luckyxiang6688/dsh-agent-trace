/** 左栏分隔比例：越界、坏存储值、零高度容器都必须安全回落。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, SPLIT_KEY, clampRatio, ratioFromPointer,
  readStoredRatio, splitterUsable, writeStoredRatio,
} from '../src/client/split.ts'

const storageOf = (value: string | null): { getItem(key: string): string | null } => ({
  getItem(key: string) {
    assert.equal(key, SPLIT_KEY)
    return value
  },
})

test('比例夹到 [15%, 85%]，越界与 NaN 都回落默认值', () => {
  assert.equal(clampRatio(0), MIN_RATIO)
  assert.equal(clampRatio(1), MAX_RATIO)
  assert.equal(clampRatio(-3), MIN_RATIO)
  assert.equal(clampRatio(Number.NaN), DEFAULT_RATIO)
  assert.equal(clampRatio(0.5), 0.5)
})

test('存储值：没有/坏值回落默认，越界被夹住', () => {
  assert.equal(readStoredRatio(storageOf(null)), DEFAULT_RATIO)
  assert.equal(readStoredRatio(storageOf('')), DEFAULT_RATIO)
  assert.equal(readStoredRatio(storageOf('abc')), DEFAULT_RATIO)
  assert.equal(readStoredRatio(storageOf('0.7')), 0.7)
  assert.equal(readStoredRatio(storageOf('9')), MAX_RATIO)
  assert.equal(readStoredRatio(undefined), DEFAULT_RATIO)

  // 读写异常（隐私模式）不得抛出
  const broken = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  }
  assert.equal(readStoredRatio(broken), DEFAULT_RATIO)
  writeStoredRatio(0.6, broken)
})

test('写入的是夹过界的比例字符串', () => {
  let written: string | undefined
  writeStoredRatio(0.02, { setItem(_key, value) { written = value } })
  assert.equal(written, String(MIN_RATIO))
})

test('指针位置换比例：零高度容器不除零', () => {
  assert.equal(ratioFromPointer(200, 100, 400), 0.25)
  assert.equal(ratioFromPointer(0, 100, 400), MIN_RATIO)
  assert.equal(ratioFromPointer(500, 100, 400), MAX_RATIO)
  assert.equal(ratioFromPointer(200, 100, 0), DEFAULT_RATIO)
})

test('容器太矮时不画分隔条', () => {
  assert.equal(splitterUsable(400), true)
  assert.equal(splitterUsable(120), false)
  assert.equal(splitterUsable(Number.NaN), false)
})
