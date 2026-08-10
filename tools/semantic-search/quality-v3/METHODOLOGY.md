# 语义反查质量集方法

## 定位与适用范围

`development.json` 是面向真实词典查询意图的场景平衡开发集，用于检索算法设计、参数选择和回归分析。它刻意提高短查询、多义、scope 干预、词条内证据和长尾表达的权重，不声称复现生产流量分布，也不用于估计线上查询频率。

本目录包含可反复用于设计的开发集，以及算法冻结后独立建立的一次性盲测集。开发集行不得随机抽取后充当盲测。所有带 `pairGroup` 或 `leakageGroup` 的行必须作为不可拆分的原子组。

## 语料版本

标注锚定到以下只读反查 sidecar：

- 文件大小：71,245,824 字节
- SHA-256：`317c0e9bd9fcbaf76ca64349b60ae570cdc3378db81561cc56e705a6b8f5c5b1`
- schema：4
- projection：1.3

构建器不读取待评估搜索结果。它只根据人工给定的 headword、scope 和语义证据片段，从 sidecar 解析稳定 `entryId` 与精确 location。sidecar 版本变化后，必须重新审核 gap、entry 和 evidence，不能只更新哈希值。

## 场景配额

144 条 case 的类别配额是开发时的显式权重。scope、长度、输入形态等是与类别交叉的独立维度，不能由 category 静态推导。

| 类别 | 数量 | 权重 | 主要意图 |
|---|---:|---:|---|
| direct-translation | 50 | 34.72% | 高频直译及同 query 的 scope 干预 |
| high-frequency-polysemy | 15 | 10.42% | 单字稳定性、多义覆盖和前排合理性 |
| descriptive-reverse | 16 | 11.11% | 不知道英文词形时的自然描述 |
| phrase-idiom | 10 | 6.94% | 短语、习语和固定搭配 |
| terminology | 9 | 6.25% | 计算、生物、经济等专业概念 |
| corpus-gap | 7 | 4.86% | 全 scope 缺失的明确词汇化概念 |
| colloquial-network | 6 | 4.17% | 口语及网络表达 |
| negation-contrast | 6 | 4.17% | 否定误解并强调目标含义 |
| usage-metalanguage | 6 | 4.17% | 语体、语法位置和含义色彩 |
| synonym-near | 5 | 3.47% | 程度、态度及变化方式的近义表达 |
| morphology-derivation | 4 | 2.78% | 前后缀、再次动作及 form 边界 |
| example-fragment | 4 | 2.78% | 用户记得的例句片段 |
| robustness-format | 3 | 2.08% | 中英混输、标点及重复脚本 |
| broad-recall | 2 | 1.39% | 明确要求一组表达的开放式查询 |
| example-scenario | 1 | 0.69% | 完整事件场景 |

长度按去除首尾空白后的 Unicode code point 数计算：1-3 字 65 条（45.14%），4-6 字 44 条（30.56%），7-12 字 25 条（17.36%），13-24 字 10 条（6.94%）。142 条标为自然查询；另外两条是有意保留的引号元语言和中英文重复输入。15 条单字查询为 `是、要、好、行、开、打、上、下、看、做、走、到、给、对、能`，主要观察结果稳定性、多义覆盖及前排顺序；它们同时属于高召回切片。显式 `broad-recall` 与这些单字 case 合计形成 17 条高召回主切片。该切片必须与整体指标和类别宏平均分开报告，不能用其中任何一项代替另外两项。

## Scope 干预

20 个 `pairGroup` 各有两条完全相同的 query，一条只请求 `sense`，另一条只请求 `phrase`。配对查询为：放弃、继续、支持、拒绝、推迟、照顾、解决、理解、结束、开始、调查、减少、增加、忍受、恢复、成功、失败、取消、批评、发现。

每一对使用不同的 scope 内目标集合，并要求 evidence scope 与请求 scope 完全一致。case 唯一性由 `id` 定义；相同 query 只允许出现在同一两行 `pairGroup`。scope 评估至少报告：各 scope 的 entry recall、配对 nDCG 差异、错误 scope 目标进入前 K 的比例，以及响应 `matches` 的 scope 泄漏率。

phrase 标注除核对中文释义外，还逐条核对前端显示的完整 `candidate_text` 和 `definition_text`。保留的 candidate 必须本身就是该中文意图下常见、直接的短语或固定搭配；不能因为某个多义 headword 的其他义项相关就保留。grade 3 表示直接且典型，grade 2 可以带明确语境限制但仍须自然。20 个 phrase 配对 case 共保留 61 个目标；对应 sense 目标也按相同语义准则复核。

对 lexical 与 hybrid 的 Top-8 联合候选池只作人工核验入口，不由返回排名自动产生标签。每个保留候选都必须在 sidecar 中确认 `entryId`、请求 scope、location 和中文意图一致；phrase 还必须确认 `candidate_text` 与 `definition_text` 指向同一释义。仅属语义近邻、依赖 headword 的其他义项或没有可见中文证据的候选不标为正例。明确的 `forbidden` 与 `corpus-gap` 判断保持独立，不能因相邻结果被取消；当前 `form=0` 时不创建 form 正例。

## 两层相关性

`relevance` 只表达 entry-level 期望：

- grade 3：最直接、最典型的答案；
- grade 2：语义正确且用户可接受的替代答案；
- grade 1：有实际关联但不是主要答案，只参与分级排序；
- grade 0：仅用于 `forbidden`，表示明确反义或明确误解。

较弱但仍合理的答案不得标成 forbidden。forbidden 只表示该 case 的明确 intent 下进入 Top-K 会构成反义或误解，不表示该 headword 在其他意图或全局范围内不相关；例如 `safe` 和 `cheap` 的判断都受各自 case intent 约束。每个 forbidden 必须在请求 scopes 内有真实文档，带 evidence 时还必须精确匹配 location。正例 recall 的主分母使用 grade 2-3；所有 grade 参与采用增益 $2^g-1$ 的 nDCG。严格一对一术语允许只有一个目标，不能用上位词或邻近概念补数量。

`evidenceExpectations` 独立表达词条内 evidence-level 期望。每项结构为 `entryId/headword/grade + evidence(scope/contains/location)`，因此 entry 命中和 evidence 命中可以分别计分。location 中 `section` 必填，`path` 为字符串数组；`part` 和 `ownerId` 只在非空时写入。schema 允许同一 entry 有多个 evidence expectation，但它们必须具有不同的 scope 或 location；当前开发集为每个 relevance target 选择一条判别性证据。464 个 entry 目标对应 464 个 evidence expectation，其中 sense 348、phrase 86、usage 18、example 12。

entry nDCG、entry recall 与 evidence recall/nDCG 必须分别报告。不能因为期望 evidence 未进入 `matches` 就把已经返回的正确 entry 记成 entry 未命中。

## 多目标与缺口

136 条 retrieval case 含 464 个 relevance target，平均每条 3.4118 个；133 条（97.79%）至少有两个目标。grade 分布为 219 个 grade 3、226 个 grade 2、19 个 grade 1。

8 条 gap case 的 `relevance` 和 `evidenceExpectations` 均为空，其中 7 条声明 `all-scopes` 缺失，1 条声明 `selected-scopes` 缺失。gap 只进入语料覆盖报告，不进入正例 recall、MRR 或 nDCG 分母。相关词返回不等于算法失败；gap 报告应列出查询、预期缺失 headword、返回候选、forbidden 命中和人工复核结论。

`form` 的选定 scope gap 已核验为现有语料模型边界。CanonicalForm 没有中文 translation，纯英文 `form.text` 或 `form.note` 会被可见中文投影边界排除；附属于 form 的中文 sense 仍进入 `sense`。因此当前 sidecar 中 `form=0`，这不表示 importer 漏导数据。开发集不伪造 form 正例，也不能据此评价 form 内证据排序。若将来 projection 产生中文 form 文档，validator 会要求重新标注并停止接受当前 gap 假设。

## 分组与防泄漏

`pairGroup` 表示相同 query 的 scope 干预；`leakageGroup` 表示不能跨数据切分的近重复或同意图族。除 20 个 scope 对外，开发集还把放弃、开心、马上、通胀、谨慎、划算和 predictable/form 边界等近邻行绑定成组。任何随机、分层或交叉验证拆分都必须先按 `leakageGroup` 聚合，再分配完整组。

同义改写只有在承担明确鲁棒性、scope 或表达强度对照时保留。构建器不自动扩写 query；新增改写必须给出组标识和独立测试目的。

## 必报指标

每次调参报告必须同时给出下列面板，不能只按单一总分选择方案：

1. 整体 entry nDCG@8、MRR、Hit@1/3/5/8、grade 2-3 Recall@1/3/5/8。
2. retrieval 类别内指标及类别宏平均；类别宏平均为各有正例类别指标的等权平均，不由大类别样本数主导。
3. 1-3 字、15 条单字以及 17 条高召回主切片的独立结果。
4. 20 个 scope pair 的逐对差异、跨 scope 目标泄漏和 response match scope 泄漏。
5. evidence recall/nDCG，按 sense、phrase、usage、example 分层。
6. 8 条 corpus gap 的覆盖清单、forbidden 命中和人工复核，不并入正例分母。
7. 请求延迟 p50、p95、p99，semantic applied/degraded 状态及失败率。

任何整体指标提升若伴随类别宏平均、短查询、高召回、scope、evidence 或延迟的显著退化，都应作为独立权衡记录，不能由整体均值掩盖。

## 最小 evaluator 扩展

现有 evaluator 若只支持 query 唯一且把 target 内嵌 evidence，当读取 v3 时需要四项最小调整：

1. 用 `id` 作为 case 主键，允许同一 `pairGroup` 内两条重复 query；
2. 从 `relevance` 计算 entry 指标，从独立 `evidenceExpectations` 计算 evidence 指标；
3. 将 `gap` 从正例指标分母排除，并输出单独覆盖报告；
4. 保留 `pairGroup` 与 `leakageGroup`，生成拆分和聚合报告时不得拆组。

开发集本身不要求修改线上检索 API。

## 复现与校验

在仓库根目录使用 aider conda 环境中的 Python：

```bash
conda run -n aider python tools/semantic-search/quality-v3/build_dataset.py --check
conda run -n aider python tools/semantic-search/quality-v3/validate_dataset.py
conda run -n aider python tools/semantic-search/quality-v3/build_holdout.py --check
conda run -n aider python tools/semantic-search/quality-v3/validate_holdout.py
```

validator 检查 case 数、类别、长度、自然文本标记、单字覆盖、多目标比例、平均目标数、scope pair、重复 query 分组、gap 声明、sidecar 版本，以及每个 entry/evidence/forbidden 在请求 scope 内的真实文档位置。phrase evidence 还强制精确 location 对应的 `candidate_text` 非空。它只读取 sidecar；`build_dataset.py --check` 只比较生成结果，不改写文件。

## 一次性盲测方法

`holdout.json` 是算法和参数冻结后建立的全新一次性盲测集，只用于一次最终评估。任何后续再次测试都必须从未接触既有评估表现的新候选池重新采样、重新标注并重新双审；不得重复使用本集合来选参数、解释失败、修正排序或比较新方案。构建、验证和人工复核阶段均不运行 lexical/hybrid，不调用产品 Search API、模型或 embedding provider，也不读取质量报告、API 响应、前端结果或任何算法输出。

冻结记录为：`semanticEvidenceBand=.005`，`protectedLexicalTier=2`；`hybrid_ranking.go` SHA-256 为 `2e4fc6ab14145cfb42c309f870f401c008097bd480e2c887a0f64b314711ce91`；`reverse-search.db` SHA-256 为 `317c0e9bd9fcbaf76ca64349b60ae570cdc3378db81561cc56e705a6b8f5c5b1`；`semantic-search.db` SHA-256 为 `2c76deca5f4d02a76df2d4007c3fecdd40648b310b2473a24de286095910af1f`。构建器只读取前述 reverse sidecar 和 development 的泄漏/目标新颖度集合；算法文件及 semantic sidecar 的指纹只作为冻结记录，不进入标签解析。

候选来自三个在未查看开发表现的前提下独立生成的池。最终 192 条中，短查询池 A 为 51 条（26.56%），自然意图池 B 为 74 条（38.54%），证据与边界池 C 为 67 条（34.90%）。原始池无法提供足够的 13–24 字输入，因此部分描述、对比和场景 seed 在保持用户意图不变的前提下改写为自然长输入；每条 case 保留唯一 `pool-seed:*` tag 供追溯。候选池中排除 development 单字和重复意图后，可用的高频多义输入支持 16 条，因此该类相对建议配额下调 2 条，代表常见表达的直译类相应上调 2 条。类别在建立标签前冻结为 42 条直译、16 条高频多义、24 条描述找词、16 条短语习语、14 条术语、10 条语料缺口、14 条口语网络、10 条否定对比、10 条用法元语言、8 条近义程度、6 条词形派生、8 条例句片段、6 条格式鲁棒、4 条开放召回和 4 条完整场景。

查询长度按去除首尾空白后的 Unicode code point 数计算，四档分别为 66、55、39、32 条；186 条标为自然输入。10 条单字与开发集的 15 个单字完全不同，并带高频、多义、稳定性和字面路径标签。14 个 `pairGroup` 形成 28 行完全相同 query 的 sense/phrase 干预；两行使用互斥 scope、不同目标集合和同一 `leakageGroup`。当前 sidecar 的 form 中文文档仍为零，盲测不创建 form 正例，也不依赖 selected-scope gap。

防泄漏首先对 query 做 NFKC、casefold，再删除空白及 Unicode 标点/符号，要求 development 与 holdout 签名零交集；原始 query、单字和 `leakageGroup` 同样不得跨 split。标注员另行人工排除只换说法却复测同一罕见意图的近重复，并为每条 case 写入 `leakageAuditStatus=development-distinct`。常见 headword 可以跨集合出现，以保持真实需求代表性；167/182 条检索 case 至少含一个 grade 2–3 且 entryId 未进入 development 目标的 `novel-target`。

标签在先确定意图、scope 和类别后，只通过只读 SQLite 探索和核验。每个 relevance 都有独立 `evidenceExpectation`，精确锚定 entryId、headword、scope、contains、section、path 以及非空时的 part/ownerId。phrase 额外要求定位行的 `candidate_text` 非空，且候选短语本身回答意图。10 个 gap 的 missing headword 在全 scope 中均不存在。最终 182 条检索 case 含 422 个 grade 2–3 目标，平均 2.3187 个；156 条（85.71%）至少有两个。grade 3 为 233 个，grade 2 为 189 个；没有为凑数保留 grade 1。证据按 sense、phrase、usage、example 分别为 357、26、17、22 个，另有 10 个明确反义或意图逆转的 forbidden。

全部 192 条先由主标注流程逐项核验，再分成三个互斥的 64 条分片，由独立只读审计员检查意图、grade、location、phrase candidate、否定和 gap；审计员不得修改文件、查看检索结果或派生其他代理。审计异议回到构建器源码修正，`holdout.json` 始终由构建器确定性生成，禁止手工漂移。`validate_holdout.py` 同时复核上述配额、防泄漏、新目标标签、候选池来源、双审状态、sidecar 指纹和每条 SQLite 证据。

## 局限

- 场景权重来自词典产品风险与用户意图设计，不来自生产日志；不能据此推断线上类别占比。
- 相关性集合由人工语义判断形成，尤其是开放式同义词和例句片段不保证穷尽全部合理答案。
- development 会被反复用于设计与调参，存在适配风险；最终结论必须来自算法冻结后的独立盲测。
- corpus gap 随词典版本变化，严格依赖上面的 sidecar pin。
- usage 元语言选择了可核验的代表词条，不声称覆盖所有带同类语法或语体说明的 entry。
- 当前 form 边界使 form 正例和 form evidence 排序不可测；相关结论必须保持为空。
