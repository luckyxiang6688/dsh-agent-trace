import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants, zstdCompressSync } from 'node:zlib'
import { decodeZstdFrames } from '../src/adapter/session/zstd.ts'

const frame = (text: string) => zstdCompressSync(Buffer.from(text, 'utf8'))

test('多帧日志要全部解出来，不能只解第一帧', () => {
  const buffer = Buffer.concat([frame('第一行\n'), frame('第二行\n'), frame('第三行\n')])
  assert.equal(decodeZstdFrames(buffer), '第一行\n第二行\n第三行\n')
})

test('单帧照常工作', () => {
  assert.equal(decodeZstdFrames(frame('only\n')), 'only\n')
})

test('不是 zstd 的输入返回空串，不抛', () => {
  assert.equal(decodeZstdFrames(Buffer.from('plain text', 'utf8')), '')
})

test('帧内部的假魔数不会把后面整段吞掉', () => {
  // 用不可压缩的数据，让魔数字节原样出现在压缩帧内部——切错就会解压失败。
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const noise = Buffer.alloc(4000)
  for (let index = 0; index < noise.length; index++) noise[index] = (index * 37 + 11) % 251
  const tricky = zstdCompressSync(Buffer.concat([noise, magic, noise]), {
    params: { [constants.ZSTD_c_compressionLevel]: 1 },
  })
  assert.ok(tricky.indexOf(magic, 1) > 0, '夹具前提：魔数确实出现在压缩数据内部')

  const decoded = decodeZstdFrames(Buffer.concat([tricky, frame('tail\n')]))
  assert.ok(decoded.endsWith('tail\n'), '第二帧不能被假魔数吞掉')
})
