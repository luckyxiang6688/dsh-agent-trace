/**
 * 会话日志是**多帧** zstd：Node 的 `zstdDecompressSync` 只解第一帧，
 * 直接整文件调用会静默丢掉其余帧（实测：60KB 文件只解出 261 字节的 header）。
 * 这里按帧魔数切开，逐帧解压再拼接。
 *
 * 帧魔数也可能出现在压缩数据内部；切开后解压失败就把边界往后挪一帧重试。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 读取并解压整个会话文件。文件不可读或不是 zstd 时返回空串，不抛。 */
export function decodeSessionText(file: string): string {
  try {
    return decodeZstdFrames(readFileSync(file))
  } catch {
    return ''
  }
}

/**
 * 只解第一帧：header 就在第一帧里，逐帧切开会把整个文件都解一遍。
 * 注意只适用于「首行即全部所需」的读取。
 */
export function decodeFirstFrame(file: string): string {
  try {
    return zstdDecompressSync(readFileSync(file)).toString('utf8')
  } catch {
    return ''
  }
}

/** 逐帧解压一个多帧 zstd 缓冲。无法解码的部分丢弃，不让一帧坏数据毁掉整次读取。 */
export function decodeZstdFrames(buffer: Buffer): string {
  let out = ''
  let start = buffer.indexOf(MAGIC)
  if (start < 0) return ''
  while (start < buffer.length) {
    const firstBoundary = nextMagic(buffer, start + MAGIC.length)
    let end = firstBoundary
    let decoded: string | undefined
    while (end !== undefined) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
        break
      } catch {
        // 这个魔数在帧内部：把边界往后挪，继续试。
        end = nextMagic(buffer, end + MAGIC.length)
      }
    }
    if (decoded === undefined) {
      // 后面没有候选边界才是「最后一帧」，这时读到文件尾。
      // 有边界但全解不开，说明帧本身坏了：停在这里，不能拿整段尾巴冒充成功。
      if (firstBoundary !== undefined) break
      try {
        decoded = zstdDecompressSync(buffer.subarray(start)).toString('utf8')
      } catch {
        break
      }
      end = buffer.length
    }
    if (end === undefined) break
    out += decoded
    start = end
  }
  return out
}

function nextMagic(buffer: Buffer, from: number): number | undefined {
  const at = buffer.indexOf(MAGIC, from)
  return at < 0 ? undefined : at
}
