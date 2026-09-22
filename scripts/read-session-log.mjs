// 临时诊断:解压 dsh 会话日志(拼接 zstd 帧),检索含关键词的行
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xFD2FB528
const path = process.argv[2]
const needle = (process.argv[3] ?? 'prepare').toLowerCase()
const buf = readFileSync(path)

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

const { frames } = scanFrames(buf)
console.error(`frames: ${frames.length}`)
let hits = 0
for (const [start, end] of frames) {
  const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  for (const line of text.split('\n')) {
    if (line.toLowerCase().includes(needle)) {
      hits += 1
      console.log(line.slice(0, 2000))
      if (hits >= 12) process.exit(0)
    }
  }
}
console.error(hits === 0 ? `no lines containing '${needle}'` : `${hits} hit(s)`)
