# Testing And Retrieval Quality

本文汇总 Lexicon 当前发布门禁、语义检索评估、向量复用边界，以及用法语料的全库审计结果。软件测试验证实现是否遵守既定契约；检索评估衡量有限标注集上的相关性。两者使用不同分母，不合并成一个“总通过率”。

## Audited Baseline

- 公共代码基线：`e5e0682`
- GitHub Actions run：[`31406926937`](https://github.com/ShallowDream724/lexicon/actions/runs/31406926937)
- 主词典 SHA-256：`f6ac9d3e20482112b24ca4142481e5b5ba78efbc9cbca85299e0ac4fc86e22d5`
- 反查侧库：schema 5 / projection 1.4 / `6a5288a931c1818fa064e030dc6476b72724717444ee751f52e26fc38e73fab0`
- 语义侧库：schema 2 / projection 1.1 / `c17d6b478e0ab0dfa5868abf32209b84dab6b1c82abacfac8ae5ccc24fe4273b`

## Software Release Gate

最新 CI 在安装锁定的 Node、Go 和 Python 依赖后完成全部步骤。

| Suite | Construction | Final result |
| --- | --- | ---: |
| TypeScript contracts | 29 个测试文件，覆盖 adapter、Canonical 模型、搜索投影、位置契约、浏览器存储和 UI 状态模型 | 156 passed, 0 failed |
| Runtime assets | 校验五项 Release 资源的类型、路径、大小、SHA-256、schema 和数据库指纹绑定 | 5 passed, 0 failed |
| Go dictionary API | 19 个 `_test.go` 文件；12 个含测试包使用临时 SQLite、ZIP、HTTP handler 和并发场景，另 7 个命令包无测试文件 | 125 passed, 0 failed |
| Semantic builder and evaluator | 7 个构建器测试与 9 个质量评估测试 | 16 passed, 0 failed |
| Rendered web and PWA | 对 production output 验证 SSR、深链、manifest、Service Worker 和离线页 | 5 passed, 0 failed |

以下步骤也是发布门禁，但不计作测试用例：ESLint、TypeScript typecheck、Next.js production build、公开 Compose 解析和镜像构建、Caddy 配置验证。最新 CI 中全部成功。

### Why These Suites Exist

契约测试使用结构化 fixture 验证数据跨边界后的业务含义，例如嵌套义项、短语位置、词形所有权和 evidence 定位。它们避免只断言“组件能渲染”这类表层结果。

Go 测试直接建立最小运行数据库和媒体归档，覆盖 schema 验证、有界查询、缓存、超时、并发合并、语义降级和 HTTP 响应。资源测试把代码与不可提交到 Git 的运行资产绑定，防止部署时混用不同版本的数据库。

Python 测试验证语料去重、确定性采样、provider 计费、预算预留、构建中断续跑、int8 评分、整库向量复制、开发集与盲测泄漏检查、分级相关性、scope 泄漏和延迟统计。

## Semantic Evaluation Layers

语义检索使用四层评估，分别回答模型选择、量化损失、算法调参与最终泛化能力。历史 v2 数据只用于追踪演进，不参与当前发布结论。

| Layer | Cases | Used for tuning | Purpose |
| --- | ---: | --- | --- |
| Model selection suite | 67 | yes | 比较 embedding 模型本身，排除 lexical fusion |
| Quality v2, historical | 80 | yes | 早期 HTTP 开发基线；旧资产与旧 schema，不与 v3 横比 |
| Quality v3 development | 144 | yes | 排序、scope、evidence 和回归调参 |
| Quality v3 blind holdout | 192 | no | 参数冻结后的一次最终评估 |

历史 quality v2 的 80 条 case 包含 76 条检索和 4 条 gap；当时的 HTTP 基线为 entry nDCG@8 0.6122、MRR 0.6053、Recall@8 0.6316、Hit@8 0.6316，forbidden 与 scope leakage 均为 0，延迟 p50/p95/p99 为 43.4/65.6/131.3 ms。它使用旧数据库、旧标签密度和旧评估 contract，只保留作演进记录；数值不能与 v3 或盲测直接比较。

### 67-Query Model Suite

`tools/semantic-search/quality/default.json` 提供 50 条核心查询，`extended.json` 提供 17 条描述、短语和边界查询。所有候选模型使用同一语料、同一查询模板、同一目标集合和同一计分程序。这里报告 dense retrieval，尚未加入字面保护和混合排序。

| Model | Hit@1 | Hit@3 | MRR | Estimated full-corpus weighted input |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 Embedding 4B | 88.1% | 100% | 0.938 | 6.50M |
| text-embedding-3-large | 86.6% | 100% | 0.928 | 26.05M |
| Qwen3 Embedding 8B | 86.6% | 98.5% | 0.924 | 13.00M |
| cf/qwen-embedding-0.6b | 80.6% | 98.5% | 0.893 | 1.74M |
| cf/bge-m3 | 80.6% | 92.5% | 0.866 | 1.74M |
| text-embedding-3-small | 71.6% | 91.0% | 0.804 | 13.03M |

Qwen3 Embedding 4B 在该固定样本上取得最高排序质量，成为发布模型。有限 allowlist 无法穷举每个查询的所有合理同义答案，因此这组数字用于相对选型，不解释为真实用户成功率。

### Quantization And Final 67-Query Path

同一组 67 条查询比较 float16 构建缓存与 Go 运行时实际执行的 symmetric int8 路径。

| Representation | Hit@1 | Recall@32 | MRR |
| --- | ---: | ---: | ---: |
| Float16 | 55.2% | 100% | 0.660 |
| Runtime int8 | 58.2% | 100% | 0.672 |

本次样本没有观察到 int8 质量损失。最终 HTTP hybrid 对保守 headword allowlist 得到 Hit@1 49.3%、Hit@3 67.2%、Recall@32 95.5%、MRR 0.615。三个名义 miss 的返回结果经人工复核均是合理替代项，标签未为提高分数而回写。

### V3 Development Set Construction

开发集包含 144 条 case，其中 136 条检索 case、8 条明确语料缺口。它有 464 个 entry target 和 464 个独立 evidence expectation；grade 3/2/1 分别为 219/226/19。133 条检索 case 至少有两个可接受目标。

| Category | Cases | Category | Cases |
| --- | ---: | --- | ---: |
| direct translation | 50 | descriptive reverse | 16 |
| high-frequency polysemy | 15 | phrase and idiom | 10 |
| terminology | 9 | corpus gap | 7 |
| colloquial network | 6 | negation contrast | 6 |
| usage metalanguage | 6 | synonym near | 5 |
| morphology and derivation | 4 | example fragment | 4 |
| robustness format | 3 | broad recall | 2 |
| complete scenario | 1 |  |  |

长度分层为 1-3 字 65 条、4-6 字 44 条、7-12 字 25 条、13-24 字 10 条；142 条为自然输入，15 条为单字查询。20 组相同 query 的 sense/phrase 配对用于检查 scope 干预。每个正例先由人工确定语义，再通过只读 sidecar 解析并验证 entryId、scope、section、path、part 和 ownerId；phrase 还必须有可显示的 candidate 与 definition。

开发集允许反复用于调参，因此它用于诊断和回归，不能证明泛化能力。当前 schema 5 / projection 1.4 侧库上的最终 HTTP hybrid 结果为：

| Metric | Result |
| --- | ---: |
| Entry nDCG@8 | 0.5220 |
| MRR, grade >= 2 | 0.6288 |
| Recall@8 | 0.5876 |
| Hit@8 | 0.8897 |
| Evidence recall@8 | 0.5843 |
| Evidence nDCG@3 within entry | 0.5389 |
| Forbidden item / case rate | 0.00087 / 0.00694 |
| Scope leakage | 0 |
| Semantic applied | 129 / 129 eligible |
| Latency p50 / p95 / p99 | 692.8 / 967.7 / 1295.5 ms |

464 个标注目标中有 445 个 grade 2-3 目标进入主 recall 与 evidence 分母；19 个 grade 1 只参与分级排序。该次运行发生在查询缓存尚未覆盖完整开发集时，因此延迟包含 provider 调用，不能与纯缓存命中延迟混用。

### Blind Holdout Construction

盲测在 `semanticEvidenceBand=0.005`、`protectedLexicalTier=2` 和排序代码哈希冻结后建立。构建、标注和复核阶段不运行产品 Search API，不读取 lexical/hybrid 输出，也不调用 embedding provider。

192 条 case 来自三个独立候选池：51 条短查询、74 条自然意图、67 条 evidence 与边界查询。它包含 182 条检索 case、10 条全 scope 缺口、422 个 grade 2-3 target 和 422 个定位 evidence；167/182 条检索 case 至少有一个未出现在开发集目标中的新 entryId。

查询经过 NFKC、casefold、删除空白与标点后的签名与开发集零交集；单字、原始 query 和 leakage group 也不得跨集合。192 条 case 分成三个互斥的 64 条分片，由独立只读审计逐项检查意图、grade、location、phrase、否定和 gap。盲测只运行一次，结果没有回流调参。

一次性评估运行在方法文档冻结的 schema 4 / projection 1.3 资产上。当前 schema 5 / projection 1.4 只新增词头词形关系；188,851 条搜索文档、178,382 条有序唯一中文文本和排序算法保持不变，最终 semantic sidecar 因此能够逐块复用全部旧向量。当前 validator 已用新侧库重新核验全部 case、scope 和 location。按照一次性盲测纪律，没有为了更新数据库哈希而再次执行或重新解释这组结果。

### Final Blind Results

| Metric | Lexical | Hybrid | Relative change |
| --- | ---: | ---: | ---: |
| Entry nDCG@8 | 0.1704 | 0.2172 | +27.4% |
| MRR, grade >= 2 | 0.2040 | 0.2469 | +21.0% |
| Recall@8 | 0.1859 | 0.2372 | +27.6% |
| Hit@8 | 0.2747 | 0.3297 | +20.0% |
| Evidence recall@8 | 0.1398 | 0.1754 | +25.4% |
| Evidence nDCG@3 within entry | 0.1301 | 0.1627 | +25.1% |
| Forbidden item rate | 0 | 0 | unchanged |
| Scope leakage | 0 | 0 | unchanged |

Lexical 延迟 p50/p95/p99 为 25.4/64.3/125.8 ms。Hybrid 为 3023.9/3061.8/3085.5 ms，因为当时的 provider 在三秒截止时间内只完成 46/182 条 eligible case；136 条按线上策略无感降级到完整 lexical 结果。该结果衡量真实失败策略，不能当作 provider 永远可用时的纯排序上限。

## Vector Reuse

构建期文档向量与运行期查询向量使用两套独立机制。

### Build Checkpoint Resume

构建缓存是按排序后的唯一中文文本建立的 float16 矩阵。fingerprint 包含 builder 版本、完整 corpus fingerprint、主库和反查库 SHA-256、model key、provider model、维度、query template 以及 document/query provider options。

同一 fingerprint 的构建中断后，`checkpoint.json` 的 completed bitmap 允许只请求未完成文本。任何影响 fingerprint 的变化都会拒绝继续，要求使用新输出目录或显式 `--rebuild`。测试覆盖 provider 中断、已完成行保留和恢复后仅请求剩余行。

### Whole-Sidecar Reuse

`--reuse-vectors-from` 会验证模型、维度、量化、block size、document options、向量数量，以及按 id 排序的每一条中文文本。全部一致后，它逐块复制旧 sidecar 的 int8 向量，同时用当前 projection 重写 metadata 和 documents。

最终 schema 5 / projection 1.4 侧库使用了这条路径：178,382 条文本与旧语料完全相同，因此文档向量请求为 0、token 为 0，新的主库和反查库指纹进入新 sidecar。复用发生在整库级别。

首次全量构建记录了 1,677,023 个 document input token、1,394 次文档请求和 2,000 个评估 input token；按当时 provider 的 4x 输入倍率，共 6,716,092 weighted units。最终 schema 5 重建因整库复用没有新增 provider 消耗。

### Current Limitation

当前没有“按中文文本交集复用、只请求新增或变化文本”的差分构建器。文本集合、顺序或数量发生任何变化时，checkpoint fingerprint 失配；`--reuse-vectors-from` 也会拒绝整库复制。

因此，修改 usage projection 后，现有实现会重新生成全部 178,382 个向量，而非只生成 7,711 个 usage 唯一文本。若目标是只重算 usage，必须先实现并测试 text-keyed incremental reuse：以 embedding contract 与规范化中文文本为 key，从旧 sidecar 复制交集向量，只向 provider 请求新增集合，并对删除、重复、顺序变化和 contract 变化做确定性校验。

### Runtime Query Cache

运行期缓存只保存用户提交 query 的向量。内存 LRU、相同 query 并发合并和可选 SQLite 缓存会复用 scope 切换、分页、重复查询及重启后的向量。持久缓存使用 HMAC-SHA-256 key，不保存 query 原文；namespace 包含完整 embedding contract。它不参与文档侧库重建。

## Full-Corpus Usage Audit

最终 reverse sidecar 包含 11,934 条 usage 文档、7,711 个不同中文文本，分布在 5,795 个 entry。它们不是同一种结构。

| Section | Usage documents |
| --- | ---: |
| definitions | 6,916 |
| grammar-usage | 4,285 |
| idioms | 402 |
| phrasal-verbs | 302 |
| derived-forms | 29 |

顶层 canonical path 还分为 `senses` 6,530、`subentries` 4,855、`headwordUsage` 280、`idioms` 117、`grammarUsageBoxes` 74、`phrasalVerbs` 51、`derivedForms` 27。更深层路径包含 `inlineUsage` 4,111、`grammarUsageBoxes` 2,011、`usageSegments` 404、`leadingUsage`、form usage 和 box blocks 等来源。

Canonical schema 本身区分 sense `inlineUsage`、`usage`、`usageSegments`、`grammarUsageBoxes`，phrase `leadingUsage`，以及 form `note`/`usage`。adapter 再根据 source path 和 token kind 形成这些结构。文本中是否出现 `NOTE`、`Patterns` 或 `reference` 只是少数表面信号，不能成为完整分类器。

可复现的基础统计：

```sql
SELECT scope, COUNT(*)
FROM documents
GROUP BY scope;

SELECT section, COUNT(*)
FROM documents
WHERE scope = 'usage'
GROUP BY section;

SELECT json_extract(path_json, '$[0]') AS root, COUNT(*)
FROM documents
WHERE scope = 'usage'
GROUP BY root;
```

### What Can Be Proven

结构完备可以证明：全库每条 usage document 必须映射到一个已知 canonical origin kind，分类计数之和等于 11,934，未分类数与重复归属数均为 0；每条可搜索 evidence 还必须有可渲染内容和精确 location。

“用户一定觉得结果好”无法对开放式自然语言作数学证明。可建立的证据是：覆盖全部结构类型的人工标注开发集、规则冻结后的新盲测、按 origin kind 与产品类别分层的 entry/evidence 指标、forbidden 和 scope leakage 为零，以及真实超时策略下的延迟与降级率。

### Required Gate Before Usage Redesign

当前把 usage 粗分成 pattern、note、reference 的方案只是一层产品语义设想，尚不足以证明全库覆盖，也没有进入生产代码。后续实现必须先通过以下门禁：

1. 在 projector 中增加 source-neutral `usageOriginKind`，覆盖全部 canonical paths，构建时 `unclassified = 0`。
2. 将产品检索策略与结构来源分开：每个 origin kind 再明确映射为 semantic-searchable、lexical-only 或 display-only；禁止用字符串关键字作为唯一判据。
3. 对 11,934 条文档执行全量锚点审计，拒绝无可见 anchor、聚合过宽或无法精确跳转的 evidence。
4. 在重算前实现 text-keyed incremental reuse，或明确接受全量 178,382 向量成本；当前不存在只重算 usage 的路径。
5. 建立覆盖所有 origin kind 的 usage 专项开发集；规则冻结后另建不重用既有 query 的一次性盲测。
6. 同时报告 entry 排序、词条内 evidence 排序、各 origin kind、forbidden、scope leakage、延迟和 provider 降级，不能只看总 Recall。

在这些门禁完成前，不能声称新的 usage 方案“完整且结果都好”。

## Reproduction

```bash
npm ci
python -m pip install -r tools/semantic-search/requirements.txt
npm run lint
npm run typecheck
npm run test:contracts
npm run test:assets
npm run test:api
npm run semantic-search:test
npm run build
npm run test:web
npm run semantic-search:quality:validate
conda run -n aider python tools/semantic-search/quality-v3/build_holdout.py --check
conda run -n aider python tools/semantic-search/quality-v3/validate_holdout.py
```

盲测带有防止重复使用的显式许可门禁。构建与验证方法见 [`tools/semantic-search/quality-v3/METHODOLOGY.md`](tools/semantic-search/quality-v3/METHODOLOGY.md)，模型和运行配置见 [`SEMANTIC_SEARCH.md`](SEMANTIC_SEARCH.md)。
