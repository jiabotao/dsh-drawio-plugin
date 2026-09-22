// 临时诊断:按 seq 列出会话日志事件概要
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xFD2FB528
const buf = readFileSync(process.argv[2])
const maxSeq = Number(process.argv[3] ?? 40)

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames }
    if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`bad magic at ${offset}`)
    offset += 5
    const descriptor = buffer.readUInt8(offset - 1)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryBytes = (descriptor & 0x03) === 3 ? 4 : (descriptor & 0x03)
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const payloadBytes = blockType === 0x01 ? 1 : (blockHeader >>> 3)
      if (buffer.length - offset < payloadBytes) return { frames }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push([start, offset])
  }
  return { frames }
}

const { frames } = scanFrames(buf)
for (const [start, end] of frames) {
  for (const line of zstdDecompressSync(buf.subarray(start, end)).toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (typeof event.seq !== 'number' || event.seq > maxSeq) continue
    const data = JSON.stringify(event.data ?? {})
    console.log(`seq=${event.seq} ${event.type} ${data.slice(0, 300)}`)
  }
}
