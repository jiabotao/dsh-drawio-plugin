/**
 * Client 半构建配置 — 复刻 dsh 宿主浏览器模块表的产物契约
 * (第一方预设:packages/client/tsdown.client.ts 的 clientConfig):
 *
 * ① CJS / browser,固定产物 client.js;
 * ② banner/intro/footer 把 bundle 包成工厂注册形态 —
 *    执行时只做 `window.__ModuleLoader__.load({ id, factory })`,
 *    模块体副作用在首次 require 时才运行;
 * ③ 值导入白名单(宿主种子表 PLATFORM_MODULES)保持 require,
 *    其余一律 inline;跨插件值导入禁止(协作走 cordis 服务);
 * ④ define 抹平 node 惯用法探测(process.env / import.meta.env)。
 *
 * 构建:npm run build(产物 client/lib/client.js,npm pack 前必须生成)。
 */
import { defineConfig } from 'tsdown'

/** 插件 id(graph 行 id == 包名,写错则工厂注册到错误行)。 */
const ID = '@you/dsh-drawio-plugin'

/** 宿主模块表能应答的说明符(packages/client/web/src/platform.ts 的 PLATFORM_MODULES)。 */
const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const nodeEnv = process.env.NODE_ENV ?? 'production'

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'client/src/index.ts' },
  outDir: 'client/lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  // 边界:白名单保持 require(模块表应答),其余全部 inline。
  // 注意:第一方预设用的 deps.neverBundle/alwaysBundle 是 monorepo 内部 API,
  // 公开版 tsdown(0.15)没有;等价做法 = rolldown `external` 白名单 +
  // tsdown 只对生产依赖(dependencies/peerDependencies)自动 external 的默认行为
  // (react 等在 devDependencies 里,天然 inline,不在这份白名单外的其余同理)。
  external: (id: string) => EXTERNALS.has(id),
  define: {
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
    'import.meta.env.MODE': JSON.stringify(nodeEnv),
    'import.meta.env': JSON.stringify({ MODE: nodeEnv }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
