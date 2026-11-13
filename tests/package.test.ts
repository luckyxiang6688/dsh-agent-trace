import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 发布包的成员清单。
 *
 * 2026-11-13 实测：`files` 里写 `docs` 会连 `docs/images/.omc/`（工具态）一起打进包，
 * 加 `.gitignore` 也拦不住——`files` 白名单对目录内的忽略规则不生效。
 * 所以这里钉死逐个文件，任何新增都要显式过一遍「这是不是该给用户的东西」。
 */

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string; files: string[] }

const EXPECTED = [
  'lib',
  'cordis.patch.yml',
  'docs/images/source-page.png',
  'docs/images/ticket-timeline.png',
  'README.md',
  'LICENSE',
  'package.json',
]

test('包名与版本', () => {
  assert.equal(manifest.name, 'dsh-superagent-trace')
  assert.equal(manifest.version, '0.1.0')
})

test('files 逐项钉死，且不包含目录级通配', () => {
  assert.deepEqual(manifest.files, EXPECTED)
})

test('files 里没有工具态目录', () => {
  for (const entry of manifest.files) {
    assert.ok(!entry.split('/').includes('.omc'), `${entry} 含 .omc`)
    assert.ok(!entry.includes('node_modules'), `${entry} 含 node_modules`)
  }
})
