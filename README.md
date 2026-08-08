<div align="center">
  <img src="public/icons/app-192.png" width="88" height="88" alt="Lexicon icon / Lexicon 图标">
  <h1>Lexicon</h1>
  <p><strong>A bilingual dictionary for reading words in context.</strong><br><strong>在语境中读懂单词的双语词典。</strong></p>
  <p>Search by English spelling or Chinese meaning, then read definitions, examples, pronunciation, usage notes, and etymology in one clear entry across desktop, tablet, and phone.<br>既可按英文拼写查询，也可用中文释义反查；释义、例句、发音、用法说明与词源在同一个清楚的词条中呈现，并分别适配桌面、平板和手机。</p>

  <p>
    <a href="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml"><img src="https://github.com/ShallowDream724/lexicon/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-123768" alt="MIT license"></a>
    <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-111827" alt="Next.js 16"></a>
    <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.24-2f7f8f" alt="Go 1.24"></a>
  </p>

  <p><strong>40,974 entries · 188,851 Chinese search records · 51,716 etymology articles · 128,010 headword pronunciations</strong><br><strong>40,974 个词条 · 188,851 条中文反查记录 · 51,716 篇词源文章 · 128,010 个词头发音</strong></p>
</div>

<img src="docs/readme/hero-desktop.webp" width="100%" alt="Lexicon desktop entry view / Lexicon 桌面端词条页面">

## The whole entry, kept in view

**完整词条，清楚展开**

Lexicon preserves the hierarchy of meanings, constructions, examples, usage notes, idioms, phrasal verbs, derivatives, and cross-references. Related material stays together, and the structure remains easy to scan.

Lexicon 保留词义、句型、例句、用法说明、习语、短语动词、派生词与交叉引用之间的层级。相关内容放在一起，词条结构也更容易浏览。

Chinese searches return grouped English entries with the matching definition, phrase, usage note, form, or example shown as evidence. Selecting an evidence line opens the right part of speech and scrolls to that exact content.

中文反查会把英文词条按词头分组，并直接展示命中的释义、短语、用法、词形或例句。选择某条命中依据后，会打开正确词性并定位到对应内容。

British and North American headword audio is read directly from the local archive. Sentence audio and illustrations can be connected separately. Browsing history, search history, favorites, notes, and preferences remain in the current browser profile, with no account required.

英式与北美词头发音直接从本地压缩包读取；例句音频与图解可以单独接入。浏览记录、查询历史、收藏、笔记与偏好保存在当前浏览器中，无需账号。

## Made for every screen

**为每一块屏幕而设计**

Desktop keeps the entry outline and supplementary resources within reach. Tablet layouts rebalance for portrait and landscape use. Phone layouts add touch lookup and a compact part-of-speech dock without reducing the entry to a simplified mobile version. A three-level reading-size control follows the same entry and card hierarchy on every screen.

桌面端把词条目录与补充资源放在随手可达的位置；平板端分别调整横屏与竖屏布局；手机端加入点词查询和紧凑的词性停靠栏，同时保留完整词条内容。三档阅读字号在各端沿用同一套词条与卡片层级。

Lexicon can also be installed as a PWA. Installation keeps only the small application shell on the device; entries and media are still requested from the server when needed.

Lexicon 也可以作为 PWA 安装。设备上只保留轻量应用外壳，词条与媒体仍在使用时按需请求。

<img src="docs/readme/responsive-devices.webp" width="100%" alt="Lexicon tablet and phone layouts / Lexicon 平板与手机布局">

## Word history, beside the definition

**词义旁边，也有词语的来历**

When a dictionary entry has matching etymology, a compact card shows a short preview beside it. Opening the card reveals the full article, with separate records for different parts of speech and senses. Linked words inside an article remain directly searchable.

主词条匹配到词源时，旁边会出现一张简短的预览卡。打开后可以阅读完整文章，不同词性与义项分别保留各自记录，文内关联词也能直接继续查询。

Terms found only in the etymology collection are searchable as well, with a focused result that does not invent an empty dictionary entry.

仅存在于词源资料中的词语同样可以搜索，并直接进入对应内容，不会生成空白的主词典词条。

<img src="docs/readme/etymology-reader.webp" width="100%" alt="Expanded desktop etymology reader / 桌面端展开的词源阅读器">

<p align="center">
  <img src="docs/readme/etymology-mobile.webp" width="360" alt="Expanded mobile etymology reader / 手机端展开的词源阅读器">
</p>

## Large datasets, small requests

**数据完整，请求保持轻量**

Indexed lookup and independently compressed entries let the server return only the selected result. Opening the site or installing the PWA does not download the full dictionary or the 1.06 GiB pronunciation archive.

索引查询与独立压缩词条让服务器只返回当前选择的结果。打开网站或安装 PWA 时，不会在后台悄悄下载整部词典，也不会下载 1.06 GiB 的发音包。

Broad Chinese searches open with 32 ranked entries and can progressively reveal up to 512. Each step requests only the additional page, keeping the first result fast while leaving room for deeper exploration.

范围较广的中文查询会先展示 32 个排序结果，并可逐步展开至 512 个；每次只请求新增的一页，兼顾首屏速度与继续查找的空间。

The released dataset contains 40,974 bilingual entries projected into 188,851 Chinese search records, 46,773 searchable etymology terms across 51,716 articles, and 128,010 usable headword MP3 assets. Storage design, query plans, and reproducible benchmarks are documented in [STORAGE_FORMAT.md](STORAGE_FORMAT.md).

参考数据集包含 40,974 个双语词条及其 188,851 条中文反查记录、覆盖 51,716 篇文章的 46,773 个可搜索词源词语，以及 128,010 个可用词头 MP3。存储设计、查询计划与可复现基准见 [STORAGE_FORMAT.md](STORAGE_FORMAT.md)。

## Quick start

**快速开始**

Run the complete local application with Node.js 22.13 or newer and Go 1.24 or newer.

使用 Node.js 22.13 或更高版本、Go 1.24 或更高版本，即可运行完整本地应用。

```bash
npm ci
npm run data:download
```

The download is about 1.23 GiB. It retrieves the versioned [runtime-data-v1 Release](https://github.com/ShallowDream724/lexicon/releases/tag/runtime-data-v1), verifies every file against `runtime-assets.json`, and creates the exact layout used by local development and the included Compose deployment:

完整下载量约为 1.23 GiB。命令会获取带版本的 [runtime-data-v1 Release](https://github.com/ShallowDream724/lexicon/releases/tag/runtime-data-v1)，依据 `runtime-assets.json` 校验每个文件，并创建本地开发与随附 Compose 共用的数据目录：

```text
data/
  dictionary.db
  etymology.db
  reverse-search.db
  headword-audio.zip
```

Keep `headword-audio.zip` packed. If the assets were downloaded or transferred manually, place all four files at these paths and run `npm run data:verify` before starting the application. The reverse-search sidecar is fingerprinted to the bundled primary database, so those two files must be updated together.

`headword-audio.zip` 无需解压。手动下载或传输资源时，请把四个文件放在上述路径，并在启动前运行 `npm run data:verify`。中文反查库带有主词典指纹，因此这两个文件必须配套更新。

Start the API and web application in separate terminals:

在两个终端中分别启动 API 与 Web 应用：

```bash
npm run dev:api
```

```bash
npm run dev
```

Open `http://localhost:3000`. The web application calls the dictionary API at `http://localhost:8787/api/v1` by default. `LEXICON_DATA_BASE_URL` selects a private asset mirror, and `LEXICON_DATA_DIR` selects another local data directory.

打开 `http://localhost:3000`。Web 应用默认调用 `http://localhost:8787/api/v1` 上的词典 API。可通过 `LEXICON_DATA_BASE_URL` 选择私有资源镜像，通过 `LEXICON_DATA_DIR` 选择其他本地数据目录。

For a self-hosted Docker deployment, configure `deploy/server/.env`, then start the bundled web, API, and reverse-proxy services. Full proxy, HTTPS, update, and rollback notes are in [DEPLOYMENT.md](DEPLOYMENT.md).

自托管 Docker 部署需要先配置 `deploy/server/.env`，再启动随项目提供的 Web、API 与反向代理服务。代理、HTTPS、更新与回滚说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。

```bash
cp deploy/server/.env.example deploy/server/.env
docker compose --env-file deploy/server/.env -f deploy/server/compose.yaml up -d --build
```

## Built to grow

**为持续扩展而设计**

The interface reads one canonical entry model, while import adapters, search projection, and enhancement resources remain outside the renderer. Content mapped to existing canonical senses, examples, phrases, usage blocks, forms, and boxes enters Chinese search automatically; new source formats and supplementary datasets do not scatter source-specific conditions through the UI.

界面只读取统一的规范词条模型，导入适配器、搜索投影与增强资源则独立于渲染层。映射到既有规范义项、例句、短语、用法、词形和卡片的数据会自动进入中文反查；新增数据格式或补充数据集时，无需把针对来源的判断散落到 UI 各处。

| Document<br>文档 | Scope<br>内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_MODEL.md](DATA_MODEL.md) | Module ownership and dictionary contracts<br>模块职责与词典契约 |
| [ADAPTER_GUIDE.md](ADAPTER_GUIDE.md) · [STORAGE_FORMAT.md](STORAGE_FORMAT.md) | Source adapters, indexing, compression, and migration<br>数据源适配、索引、压缩与迁移 |
| [PWA.md](PWA.md) · [DEPLOYMENT.md](DEPLOYMENT.md) | Installation, cache boundaries, self-hosting, and updates<br>安装、缓存边界、自托管与更新 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow and release checks<br>开发流程与发布检查 |

The application source is available under the [MIT License](LICENSE); the released dictionary databases and pronunciation media are provided for study use only.

应用源代码采用 [MIT License](LICENSE) 发布；发布的词典数据库与发音媒体仅供学习使用。
