# 绝对阈值校准方法

开发集仅用于枚举候选绝对分数阈值。选择规则先要求可回答查询的目标最佳分数保留率不低于 95%，再最大化拒答查询的拒绝率；完整候选 Pareto 前沿和逐条分数均写入开发报告。

阈值冻结后，持留集只以 `evaluate` 模式运行一次。该模式要求显式冻结阈值，只报告结果，不执行候选枚举或阈值选择。开发集和持留集均含 20 条可回答查询和 20 条拒答查询。

运行器仅读取 schema 5 semantic sidecar 的 `texts`、`documents` 与 int8 `vector_blocks`，以运行时一致的查询归一化、`round(clamp(x * 127))` 和 `dot / 16129` 计算。拒答项报告全库最高分和对应 headword；可回答项报告所有目标中的最佳分数。不会调用产品 Search API。

阈值兼容身份是 sidecar `model_key`，报告同时保留 `provider_model` 作为嵌入请求路由信息。每条可回答查询还会报告 top headwords、各 target 的 headword rank 和最佳 target rank；Hit@1、Hit@3、MRR 仅用于质量观察，不参与阈值选择。显示 headword 中的音节点 `·` 与重音符 `ˈˌ` 在 target 锚定时会被移除。

数据加载会校验 id、split、label、规范化 query 唯一性、正例 targets 非空、负例不存在 targets，并验证每个正例 target headword 位于选定 scope 的 sidecar 文档中。可重复提供 `--disjoint-from` 旧质量集；工具以同一规范化规则检查 query 重叠。

示例：

```bash
python tools/semantic-search/calibrate_threshold.py --mode validate --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-development.json --dataset tools/semantic-search/quality-v5/threshold-holdout.json
python tools/semantic-search/calibrate_threshold.py --mode development --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-development.json --disjoint-from tools/semantic-search/quality/default.json --base-url https://embedding.example/v1
python tools/semantic-search/calibrate_threshold.py --mode evaluate --sidecar data/semantic-search.db --dataset tools/semantic-search/quality-v5/threshold-holdout.json --threshold 0.590489181 --base-url https://embedding.example/v1
```

`validate` 模式只检查当前侧库、数据结构、目标词存在性与集合隔离，不请求 provider；开发与持留评分才需要生成查询向量。

API key 经 `OPENAI_API_KEY` 传入；可用 `--api-key-env` 指定其他环境变量。示例端点不包含真实服务地址或密钥。
