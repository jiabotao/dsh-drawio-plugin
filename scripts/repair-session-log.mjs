// 会话日志修复:给指定类型的事件补 ignorable: true 标记
//
// 背景:0.1.2 之前的 dsh-drawio-plugin 会追加自定义会话事件 drawio/rendered,
// 该类型不在 harness 构建期生成的 KNOWN_SESSION_EVENT_TYPES 内,且写入时无法
// 携带 ignorable 标记(Session.append 不暴露),导致重启后回放拒绝加载整个会话
// ("unknown to this harness and not marked ignorable")。官方兼容机制就是
// envelope 上的 ignorable: true(架构笔记 2026-08-30)。本脚本给已污染日志里
// 的匹配事件行补该标记:不删行、不改 seq,连续性不受影响。
//
// 用法: node scripts/repair-session-log.mjs <session.v3.jsonl.zstd> [eventType]
//   eventType 默认 'drawio/rendered'
// 原文件会先复制为 <file>.bak 再覆盖写回。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xFD2FB528
const path = process.argv[2]
const targetType = process.argv[3] ?? 'drawio/rendered'
if (path === undefined) {
  console.error('usage: node scripts/repair-session-log.mjs <session.v3.jsonl.zstd> [eventType]')
  process.exit(1)
}
const buf = readFileSync(path)

/** 切分拼接的 zstd 帧(与 scripts/read-session-log.mjs 同一扫描逻辑)。 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`bad magic at ${offset}`)
    offset += 5 // magic + descriptor
    const descriptor = buffer.readUInt8(offset - 1)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryBytes = (descriptor & 0x03) === 3 ? 4 : (descriptor & 0x03)
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const payloadBytes = blockType === 0x01 ? 1 : (blockHeader >>> 3)
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push([start, offset])
  }
  return { frames }
}

const { frames, tornStart } = scanFrames(buf)
if (tornStart !== undefined) throw new Error(`torn trailing data at ${tornStart}; refusing to rewrite`)

let patched = 0
let warned = false
const out = []
for (const [start, end] of frames) {
  const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  if (text.length > 0 && !text.endsWith('\n') && !warned) {
    console.error('warn: a frame does not end with newline; line-level rewrite assumes whole lines')
    warned = true
  }
  const lines = text.split('\n').map((line) => {
    if (!line.includes(targetType)) return line // 快路径:未命中行保留原文
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return line // 半行/非 JSON:不动
    }
    if (event?.type === targetType && event.ignorable === undefined) {
      patched += 1
      return JSON.stringify({ ...event, ignorable: true })
    }
    return line
  })
  out.push(zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')))
}

if (patched === 0) {
  console.error(`no "${targetType}" events missing the marker; nothing to do`)
  process.exit(0)
}
copyFileSync(path, `${path}.bak`)
writeFileSync(path, Buffer.concat(out))
console.error(`patched ${patched} event(s) across ${frames.length} frame(s); backup at ${path}.bak`)
