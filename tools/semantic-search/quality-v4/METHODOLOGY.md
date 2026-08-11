# Fresh-100 构筑与独立复核

## 结论

已逐条复核 100/100 条。审查仅使用四个分片、旧四套集合的 `query` 字段、只读 `data/reverse-search.db` 与验证脚本；未调用产品 Search API、localhost、embedding provider、当前排名或 quality report，也未读取旧集合 targets。修订后的最终集合再由两名无共享上下文的审计员各自复核 50 条，结论分别为 50/50 通过。

四个覆盖组均保持 25 条：common/short（a）、phrase/colloquial（b）、descriptive/terminology（c）、usage/example/confusable（d）。

## 修改记录

- 扩展 targets：a-01/02/03/04/05/07/08/09/10/11/13/14，补入常见直接答案及逐项精确 evidence；d-20 将原先误标 forbidden 的 `nothing` 改为 grade 3 正确答案。
- 替换旧集近重复：a-16/17/18/19/21/23；b-02/05/09/12/14/18/20；c-08/19/24；d-17/18/21/22/24/25。替换后保留原 id 与所属 25 条覆盖组，并重新绑定离线 DB 锚点。
- 语义校准：b-16 将“脸皮厚”收窄为承受批评；b-24 将“言归正传”明确为结束玩笑后说正事；d-07 的 intent 收敛到冒犯性判断。
- 最终完整性修订：a-22 将 `good job`、`nice work`、`way to go` 等直接称赞表达补入 relevance，并按典型程度分为 grade 3/2；b-17 移除因果方向不符的 `try sb's patience`，改用精确回答等待状态的 `impatient` 与 `patience`；c-05 补入英式地区变体 `tin opener`。d-11 的功能词 headword `if` 经复核保留，因为其 example 是词库中唯一直接、完整且礼貌的保密请求表达。
- forbidden 清理：删除 d-06/07/11/14/17/20/21/22/24/25 中弱相关、主题相邻或实际正确的 evidence；保留 d-16（未接通 vs 稍后回电）与 d-23（及物 `lay` vs 不及物 `lie`）两个明确方向错误。
- 未改动但逐项确认：其余 63 条的 query 自然度、意图、target grade、evidence 独立回答能力及 DB location 均逐条核对。

## 分布

- query 长度（字符规则）：短 `<=4` 19；中 `5-12` 23；长 `>=13` 58。
- 难度：easy 19；medium 59；hard 22。
- case scopes（多选计数）：sense 52；phrase 68；form 47；usage 14；example 19。
- relevance targets：grade 3 共 113；grade 2 共 24；grade 1 共 0。
- evidence scopes：sense 74；phrase 31；usage 14；example 19。
- forbidden：2 个，分布于 2 条 case，均为精确 evidence。
- 领域/类型：direct-common 15、short-colloquial 10、usage-meta 10、expression-recall 10、natural-science 6、daily-life 5、medicine 5、confusable-contrast 5、behavior 5、conversation 5，其余覆盖商业、技术、关系、决策、情绪、抽象概念、工作与结果等。

## 机器门禁

- JSON 结构与 100 条 id/query 合并约束：通过。
- 四个旧文件 `--disjoint-from` 的规范化 query 签名：通过。
- schema 7 / projection 1.6 `data/reverse-search.db` 的 entry/headword/scope/location/contains 锚点：通过。
- 当时的验证器校验 `tools/semantic-search/quality-v4/fresh-100.json`，并同时传入 default、extended、v3 development、v3 holdout 四个 `--disjoint-from`。该集合绑定历史 projection；复现必须使用其原始固定侧库，当前发布命令不再把它当作 2.2 门禁。
- 最终独立语义复核：A/B 分片 50/50 通过；C/D 分片 50/50 通过。

## 边界

规范化签名门禁能数学保证精确 query 不泄漏，人工复核用于排除换字近重复与内部同意图重复，无法数学证明所有自然语言释义空间不存在更远的语义重合。离线锚点能证明标签 evidence 存在且字段精确匹配，不能证明线上排序、召回率或模型行为；这些内容按盲审约束未被观察。

一次性线上结果及盲测后定向修复的边界记录在仓库根目录的
[`QUALITY_EVALUATION.md`](../../../QUALITY_EVALUATION.md)。
