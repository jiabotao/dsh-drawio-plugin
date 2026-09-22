#!/usr/bin/env node
/**
 * vendor 下载/更新脚本:抓取 drawio 官方 release 的 webapp 产物(draw.war),
 * 解包、裁剪服务端/集成/ServiceWorker 文件后铺进 vendor/drawio/,
 * 并写入 VERSION 与 Apache-2.0 LICENSE。不 clone git 仓库;版本 pin 死。
 *
 * 用法:
 *   node scripts/fetch-drawio.mjs <版本>     例: node scripts/fetch-drawio.mjs 31.4.5
 *   node scripts/fetch-drawio.mjs            沿用 vendor/drawio/VERSION 里的版本
 *
 * 依赖:系统 `tar`(Windows 10+ 自带 bsdtar,可解 zip/war);Node fetch(>=18)。
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VENDOR_DIR = join(PKG_ROOT, 'vendor', 'drawio')
const VERSION_FILE = join(VENDOR_DIR, 'VERSION')

/** 与服务端部署/云集成/离线缓存相关,静态嵌入不需要的条目。 */
const PRUNE_DIRS = new Set(['WEB-INF', 'META-INF', 'connect'])
const PRUNE_FILES = new Set(['service-worker.js', 'service-worker.js.map', 'monday-app-association.json'])
const PRUNE_PREFIXES = ['workbox-']

function fail(message) {
  console.error(`fetch-drawio: ${message}`)
  process.exit(1)
}

async function download(url, dest) {
  console.log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) fail(`HTTP ${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, bytes)
  return bytes.length
}

const versionArg = process.argv[2]
const version = versionArg ?? (existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf8').trim() : undefined)
if (version === undefined || version === '') fail('缺少版本号参数,且 vendor/drawio/VERSION 不存在')
const tag = version.startsWith('v') ? version : `v${version}`
const warUrl = `https://github.com/jgraph/drawio/releases/download/${tag}/draw.war`
const licenseUrl = `https://raw.githubusercontent.com/jgraph/drawio/${tag}/LICENSE`

const workDir = join(tmpdir(), `dsh-drawio-${version}-${Date.now()}`)
const warDir = join(workDir, 'war')
mkdirSync(warDir, { recursive: true })

try {
  const warPath = join(workDir, 'draw.war')
  const size = await download(warUrl, warPath)
  console.log(`draw.war: ${(size / 1024 / 1024).toFixed(1)} MiB`)

  console.log('解包(tar)')
  execFileSync('tar', ['-xf', warPath, '-C', warDir], { stdio: 'inherit' })

  // 裁剪(与初版 robocopy 的剔除清单一致)
  for (const entry of readdirSync(warDir)) {
    const full = join(warDir, entry)
    if (PRUNE_DIRS.has(entry) || PRUNE_FILES.has(entry) || PRUNE_PREFIXES.some(prefix => entry.startsWith(prefix))) {
      rmSync(full, { recursive: true, force: true })
    }
  }

  if (!existsSync(join(warDir, 'index.html'))) fail('解包结果缺少 index.html,release 布局可能已变化')

  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  cpSync(warDir, VENDOR_DIR, { recursive: true })

  // LICENSE 不在 war 里,从仓库 tag 单独取;失败不致命(保留已有文件)
  try {
    const licenseBytes = await download(licenseUrl, join(VENDOR_DIR, 'LICENSE'))
    if (licenseBytes === 0) fail('LICENSE 为空')
  } catch (error) {
    console.warn(`警告:LICENSE 下载失败(${error instanceof Error ? error.message : String(error)}),请人工补一份 Apache-2.0 LICENSE`)
  }

  writeFileSync(VERSION_FILE, version)

  let files = 0
  let bytes = 0
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += statSync(full).size
      }
    }
  }
  walk(VENDOR_DIR)
  console.log(`完成:vendor/drawio ← drawio ${version}(${files} 个文件,${(bytes / 1024 / 1024).toFixed(1)} MiB)`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
