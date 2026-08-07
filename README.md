<div align="center">
  <img src="public/icons/app-192.png" width="88" height="88" alt="Lexicon icon / Lexicon 图标">
  <h1>Lexicon</h1>
  <p><strong>A fast, installable bilingual dictionary for desktop, tablet, and phone.</strong><br><strong>面向桌面、平板和手机的快速可安装双语词典。</strong></p>
  <p>Dense reference content, integrated etymology, and personal learning tools in one carefully responsive reading surface.<br>在一个经过细致响应式设计的阅读界面中，汇集高密度词典内容、词源信息和个人学习工具。</p>

  <p>
    <a href="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml"><img src="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-123768" alt="MIT license"></a>
    <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-111827" alt="Next.js 16"></a>
    <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.24-2f7f8f" alt="Go 1.24"></a>
  </p>

  <p><strong>40,974 entries · 51,716 etymology articles · 128,010 headword pronunciations · 220,328 typo signatures</strong><br><strong>40,974 个词条 · 51,716 篇词源文章 · 128,010 个词头发音 · 220,328 个拼写纠错签名</strong></p>
</div>

<img src="docs/readme/hero-desktop.webp" width="100%" alt="Lexicon desktop entry view / Lexicon 桌面端词条页面">

## One reading surface, shaped for the device

**为不同设备塑造的统一阅读界面**

Lexicon keeps the same dictionary model across every viewport while adapting the way people navigate it.

Lexicon 在各种视口中保持一致的词典模型，同时适配不同设备上的浏览方式。

- **Desktop:** a persistent entry outline, wide reading column, and compact resource rail.<br>
  **桌面：** 常驻词条大纲、宽幅阅读栏和紧凑资源栏。
- **Tablet:** portrait and landscape compositions that preserve hierarchy without wasting width.<br>
  **平板：** 纵向和横向布局均保留信息层级，避免浪费屏幕宽度。
- **Phone:** touch lookup, a measured part-of-speech dock, and full-width supplementary resources.<br>
  **手机：** 触控查词、尺寸经过控制的词性停靠栏，以及占满宽度的补充资源。
- **Installable PWA:** a small application shell with explicit updates and an offline launch page; dictionary payloads and media are never downloaded as part of installation.<br>
  **可安装 PWA：** 轻量应用外壳，支持明确的更新流程并提供离线启动页；安装过程中不会下载词典数据或媒体资源。

<img src="docs/readme/responsive-devices.webp" width="100%" alt="Lexicon tablet and phone layouts / Lexicon 平板与手机布局">

The interface renders nested senses, constructions, examples, bilingual labels, pronunciation, illustrations, usage panels, idioms, phrasal verbs, derivatives, cross-references, and enhancements from one canonical entry contract. History, favorites, and notes remain local to the current browser profile, with no account or registration flow.

界面依据统一的规范词条契约，呈现嵌套义项、句型、例句、双语标签、发音、插图、用法面板、习语、短语动词、派生词、交叉引用和增强内容。历史记录、收藏和笔记仅保存在当前浏览器配置文件中，无需账号或注册。

## Etymology, without leaving the entry

**无需离开词条即可查看词源**

Etymology is implemented as an independent enhancement sidecar. Matching entries receive a bounded summary card; opening it loads only the selected article. Terms that exist only in the enhancement source remain searchable without manufacturing an empty primary-dictionary record.

词源信息存放在独立的增强数据库中。匹配到的词条会显示有限长度的摘要卡片；打开后仅加载所选文章。仅存在于增强数据源中的词语仍可搜索，无需生成空的主词典记录。

<img src="docs/readme/etymology-reader.webp" width="100%" alt="Expanded desktop etymology reader / 桌面端展开的词源阅读器">

<p align="center">
  <img src="docs/readme/etymology-mobile.webp" width="360" alt="Expanded mobile etymology reader / 手机端展开的词源阅读器">
</p>

Article links resolve through stable article identifiers, then return to the canonical term. The reader preserves semantic emphasis and historical-language runs while keeping the underlying entry in place.

文章链接通过稳定的文章标识符解析，再返回规范词语。阅读器保留语义强调和历史语言片段，同时维持原词条页面的位置。

## Measured scale

**可量化的规模**

The reference runtime is designed around indexed lookup and independently compressed records rather than shipping a large JSON corpus to the browser.

参考运行时围绕索引查找和独立压缩记录设计，无需向浏览器发送大型 JSON 语料库。

| Runtime surface<br>运行时内容 | Measured scale<br>实测规模 | Runtime treatment<br>运行时处理 |
| --- | ---: | --- |
| Primary dictionary<br>主词典 | 40,974 entries<br>40,974 个词条 | 51.45 MiB read-only SQLite runtime<br>51.45 MiB 只读 SQLite 运行时数据库 |
| Etymology enhancement<br>词源增强 | 46,773 terms / 51,716 articles<br>46,773 个词语 / 51,716 篇文章 | 43.30 MiB independent sidecar<br>43.30 MiB 独立扩展数据库 |
| Headword pronunciation<br>词头发音 | 128,010 usable MP3 assets<br>128,010 个可用 MP3 资源 | 1.06 GiB ZIP, indexed and streamed without extraction<br>1.06 GiB ZIP，建立索引后直接流式读取，无需解压 |
| Typo correction index<br>拼写纠错索引 | 220,328 deletion signatures<br>220,328 个删除签名 | bounded indexed probes; no substring scan<br>有界索引探测；不进行子串扫描 |
| Installable application shell<br>可安装应用外壳 | 26 precache entries / about 1.07 MiB<br>26 个预缓存条目 / 约 1.07 MiB | UI assets only; no entry JSON, SQLite, ZIP, or media<br>仅包含 UI 资源；不包含词条 JSON、SQLite、ZIP 或媒体 |

On the documented reference probe, exact and prefix HTTP search measured **7.9 ms p95** and bounded one-edit correction measured **10.3 ms p95**. These are reproducible benchmark results, not cross-hardware latency guarantees. See [STORAGE_FORMAT.md](STORAGE_FORMAT.md) for the full storage matrix, query plans, codec parameters, and measurement method.

在文档所述的参考探测中，精确搜索和前缀 HTTP 搜索的 p95 延迟为 **7.9 ms**，有界单字符编辑纠错的 p95 延迟为 **10.3 ms**。这些是可复现的基准结果，不代表跨硬件的延迟保证。完整存储矩阵、查询计划、编解码参数和测量方法请参阅 [STORAGE_FORMAT.md](STORAGE_FORMAT.md)。

## Architecture

**架构**

```text
read-only import source
        |
        v
one-way importer  ----  project-owned runtime SQLite
        |                         + optional enhancement sidecars
        v
Go search and media API
        v
TypeScript source adapter  ----  CanonicalEntry v1
        v
responsive React renderer  ----  browser-local IndexedDB learning data
        |
        +-----------------------  isolated PWA platform layer
```

The Go service owns indexed search, bounded typo recovery, storage validation, decompression, and media streaming. Source adapters own validation and conversion into the canonical UI model. React components never inspect source-table names or open storage files. Optional resource types register their ordering, card size, quick-find placement, and opening behavior through one presentation registry.

Go 服务负责索引搜索、有界拼写恢复、存储校验、解压和媒体流式传输。源适配器负责校验并转换为规范 UI 模型。React 组件不会检查源数据表名称，也不会打开存储文件。可选资源类型通过统一的展示注册表登记排序、卡片尺寸、快速查找位置和打开行为。

This separation keeps new import formats and supplementary datasets out of the core renderer. See [ARCHITECTURE.md](ARCHITECTURE.md) and [DATA_MODEL.md](DATA_MODEL.md) for the contracts and ownership rules.

这种分离使新的导入格式和补充数据集无需进入核心渲染器。契约与职责边界请参阅 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [DATA_MODEL.md](DATA_MODEL.md)。

## Technology

**技术栈**

- React 19, TypeScript, and Next.js 16 standalone output.<br>
  React 19、TypeScript，以及 Next.js 16 独立部署输出。
- Go 1.24 for the read-only SQLite and media service.<br>
  Go 1.24，用于只读 SQLite 和媒体服务。
- Serwist for the isolated Service Worker and bounded application-shell cache.<br>
  Serwist，用于隔离的 Service Worker 和有界应用外壳缓存。
- Zod at external data boundaries and IndexedDB for device-local learning records.<br>
  在外部数据边界使用 Zod，在设备本地使用 IndexedDB 保存学习记录。
- Independent Zstandard frames with shared dictionaries for random-access entry payloads.<br>
  使用带共享字典的独立 Zstandard 帧，实现词条数据的随机访问。

## Quick start

**快速开始**

Requirements: Node.js 22.13 or newer and Go 1.24 or newer. Install dependencies, then download and verify the three versioned runtime assets. The complete download is about 1.15 GiB.

环境要求：Node.js 22.13 或更高版本，以及 Go 1.24 或更高版本。安装依赖后，下载并校验三个带版本的运行时资源，完整下载量约为 1.15 GiB。

```bash
npm ci
npm run data:download
```

The downloader retrieves the [runtime-data-v1 release](https://github.com/ShallowDream724/lexicon/releases/tag/runtime-data-v1), pins file sizes and SHA-256 digests from `runtime-assets.json`, then creates the complete local data layout automatically:

下载器获取 [runtime-data-v1 Release](https://github.com/ShallowDream724/lexicon/releases/tag/runtime-data-v1)，依据 `runtime-assets.json` 校验文件大小和 SHA-256 摘要，然后自动创建完整的本地数据目录：

```text
data/
  dictionary.db
  etymology.db
  headword-audio.zip
```

`LEXICON_DATA_BASE_URL` can select a private mirror, and `LEXICON_DATA_DIR` can select another target directory. Run `npm run data:verify` whenever assets have been copied from another machine or restored from backup.

可通过 `LEXICON_DATA_BASE_URL` 选择私有镜像，通过 `LEXICON_DATA_DIR` 选择其他目标目录。从其他机器复制资源或从备份恢复后，可运行 `npm run data:verify` 再次校验。

Start the complete API and web application in separate terminals:

在两个终端中分别启动完整 API 和 Web 应用：

```bash
npm run dev:api
```

```bash
npm run dev
```

The web application opens at `http://localhost:3000` and calls the API at `http://localhost:8787/api/v1` by default. The API loads the primary dictionary, etymology sidecar, and headword pronunciation archive from `data/`. Development mode does not register a Service Worker, so stale application caches cannot mask source changes.

Web 应用默认在 `http://localhost:3000` 打开，并调用 `http://localhost:8787/api/v1` 上的 API。API 会从 `data/` 同时加载主词典、词源数据库和词头发音包。开发模式不会注册 Service Worker，因此过期的应用缓存不会掩盖源代码变更。

The three released assets provide the complete local reference dataset. Example-sentence audio and illustrations use separately configured HTTP(S) media sources; see [DEPLOYMENT.md](DEPLOYMENT.md) for the environment variables and container deployment.

三个已发布资源构成完整的本地词典数据集。例句音频和插图使用另行配置的 HTTP(S) 媒体源；相关环境变量和容器部署方式请参阅 [DEPLOYMENT.md](DEPLOYMENT.md)。

## Import and extend

**导入与扩展**

Importers are deterministic, transactional, and one-way: source databases stay read-only while the application receives project-owned schemas and indexes.

导入器具备确定性、事务性且为单向流程：源数据库保持只读，应用接收项目自有的模式和索引。

```bash
npm run dictionary:import -- \
  -source ../../data/source.db \
  -target ../../data/dictionary.db \
  -source-version source-2026-01

npm run etymology:import -- \
  -source ../../data/etymology-source.db \
  -target ../../data/etymology.db \
  -source-version etymology-2026-01
```

A new JSON, MDX, StarDict, or remote source belongs behind an adapter and fixtures rather than source conditionals in UI components. [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) documents the extension path.

新的 JSON、MDX、StarDict 或远程数据源应置于适配器和固定测试数据之后，不应在 UI 组件中加入针对数据源的条件分支。扩展路径请参阅 [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md)。

## Verification

**验证**

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` runs frontend contract tests, every Go package test, a production build, and standalone response tests for the application, manifest, icons, offline page, and Service Worker. The release matrix also covers desktop, tablet portrait, tablet landscape, and phone behavior.

`npm test` 会运行前端契约测试、所有 Go 软件包测试、生产构建，以及针对应用、清单、图标、离线页面和 Service Worker 的独立响应测试。发布矩阵还覆盖桌面、平板纵向、平板横向和手机行为。

## Documentation

**文档**

| Document<br>文档 | Scope<br>范围 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module ownership, request flow, performance rules, and compatibility<br>模块职责、请求流程、性能规则与兼容性 |
| [DATA_MODEL.md](DATA_MODEL.md) | Canonical dictionary and enhancement contracts<br>规范词典与增强契约 |
| [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) | Adding and validating source formats<br>添加并校验数据源格式 |
| [STORAGE_FORMAT.md](STORAGE_FORMAT.md) | Compression, indexing, benchmarks, and migration rules<br>压缩、索引、基准测试与迁移规则 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Self-hosted topology, assets, proxying, updates, and rollback<br>自托管拓扑、资源、代理、更新与回滚 |
| [PWA.md](PWA.md) | Installation, cache boundaries, updates, and offline behavior<br>安装、缓存边界、更新与离线行为 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow and release checks<br>贡献流程与发布检查 |

## Deployment

**部署**

The application ships as separate standalone web and Go API containers. The runtime databases and packed pronunciation archive are mounted read-only, so code releases never rewrite content assets. The deployment can use the included reverse-proxy reference or join an existing proxy network; see [DEPLOYMENT.md](DEPLOYMENT.md) for the branch-specific topology and commands.

应用以独立的 Web 和 Go API 容器交付。运行时数据库和打包的发音压缩包以只读方式挂载，因此代码发布不会重写内容资源。部署可使用随附的反向代理参考配置，或加入现有代理网络；分支对应的拓扑和命令请参阅 [DEPLOYMENT.md](DEPLOYMENT.md)。

## Data and licensing

**数据与许可**

The application source is available under the [MIT License](LICENSE); dictionary information in the released databases is provided for study use only.

应用源代码采用 [MIT License](LICENSE) 发布；已发布数据库中的词典信息仅供学习使用。
