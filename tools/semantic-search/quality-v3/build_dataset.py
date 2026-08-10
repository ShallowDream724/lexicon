"""Build the scenario-balanced semantic reverse-search development set.

The builder reads the pinned reverse-search sidecar in SQLite read-only mode. It
resolves every annotated headword to one concrete entry and evidence document;
it never derives relevance labels from the search endpoint being evaluated.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
DEFAULT_REVERSE_DB = REPOSITORY / "data" / "reverse-search.db"
DEFAULT_OUTPUT = HERE / "development.json"
SCOPES = ("sense", "phrase", "usage", "example", "form")


@dataclass(frozen=True)
class TargetSpec:
    headword: str
    grade: int
    anchor: str
    scope: str | None = None


@dataclass(frozen=True)
class ForbiddenSpec:
    headword: str
    anchor: str | None = None
    scope: str | None = None


def t(headword: str, grade: int, anchor: str, scope: str | None = None) -> TargetSpec:
    return TargetSpec(headword, grade, anchor, scope)


def f(headword: str, anchor: str | None = None, scope: str | None = None) -> ForbiddenSpec:
    return ForbiddenSpec(headword, anchor, scope)


def _length_band(query: str) -> str:
    length = len(query.strip())
    if 1 <= length <= 3:
        return "1-3"
    if 4 <= length <= 6:
        return "4-6"
    if 7 <= length <= 12:
        return "7-12"
    if 13 <= length <= 24:
        return "13-24"
    raise ValueError(f"query length is outside the benchmark bands: {query!r} ({length})")


def retrieval(
    case_id: str,
    query: str,
    category: str,
    scopes: Sequence[str],
    targets: Sequence[TargetSpec],
    intent: str,
    *,
    tags: Sequence[str] = (),
    forbidden: Sequence[ForbiddenSpec] = (),
    pair_group: str | None = None,
    pair_role: str | None = None,
    leakage_group: str | None = None,
    query_style: str = "natural",
    is_natural_query: bool = True,
) -> dict[str, Any]:
    return {
        "id": case_id,
        "query": query,
        "split": "development",
        "category": category,
        "scopes": list(scopes),
        "expectation": "retrieval",
        "intent": intent,
        "tags": list(tags),
        "queryStyle": query_style,
        "isNaturalQuery": is_natural_query,
        "queryLength": len(query.strip()),
        "lengthBand": _length_band(query),
        "targetSpecs": list(targets),
        "forbiddenSpecs": list(forbidden),
        **({"pairGroup": pair_group, "pairRole": pair_role} if pair_group else {}),
        **({"leakageGroup": leakage_group} if leakage_group else {}),
    }


def gap(
    case_id: str,
    query: str,
    category: str,
    scopes: Sequence[str],
    intent: str,
    missing_headwords: Sequence[str],
    *,
    absence: str = "all-scopes",
    tags: Sequence[str] = (),
    forbidden: Sequence[ForbiddenSpec] = (),
    leakage_group: str | None = None,
    query_style: str = "natural",
    is_natural_query: bool = True,
) -> dict[str, Any]:
    return {
        "id": case_id,
        "query": query,
        "split": "development",
        "category": category,
        "scopes": list(scopes),
        "expectation": "gap",
        "intent": intent,
        "tags": list(tags),
        "queryStyle": query_style,
        "isNaturalQuery": is_natural_query,
        "queryLength": len(query.strip()),
        "lengthBand": _length_band(query),
        "targetSpecs": [],
        "forbiddenSpecs": list(forbidden),
        "gap": {
            "type": "corpus-gap",
            "absence": absence,
            "missingHeadwords": list(missing_headwords),
        },
        **({"leakageGroup": leakage_group} if leakage_group else {}),
    }


def _scope_pair_cases() -> list[dict[str, Any]]:
    # The two rows in every pair have exactly the same query and deliberately
    # different scope-specific targets. This is an intervention on scope, not a
    # paraphrase pair.
    pairs: list[tuple[str, str, Sequence[TargetSpec], Sequence[TargetSpec]]] = [
        ("放弃", "停止继续或舍弃", (t("abandon", 3, "放弃"), t("drop", 2, "放弃"), t("surrender", 2, "放弃"), t("yield", 2, "放弃"), t("reverse", 1, "放弃（立场）"), t("chuck", 2, "放弃"), t("abandonment", 2, "放弃")), (t("give", 3, "放弃"), t("back", 2, "放弃"), t("get", 1, "放弃，戒除"), t("let", 2, "放弃，摒弃"), t("part", 2, "放弃，交出"), t("pass", 2, "放弃，不要"), t("hand", 2, "放弃，退出"), t("bottle", 1, "中途）放弃"))),
        ("继续", "保持动作或状态不中断", (t("continue", 3, "继续"), t("keep", 2, "继续"), t("last", 2, "继续")), (t("go", 2, "继续"), t("keep", 3, "继续"), t("carry", 3, "继续"))),
        ("支持", "赞同、帮助或为其提供支撑", (t("support", 3, "支持"), t("back", 2, "支持"), t("endorse", 2, "支持")), (t("back", 3, "支持"), t("stand", 3, "支持"), t("get", 3, "支持"))),
        ("拒绝", "明确表示不接受", (t("refuse", 3, "拒绝"), t("reject", 3, "拒绝"), t("decline", 2, "拒绝")), (t("say", 3, "拒绝"), t("turn", 3, "拒绝"), t("draw", 2, "拒绝做"))),
        ("推迟", "把计划安排到更晚时间", (t("postpone", 3, "推迟"), t("delay", 3, "推迟"), t("defer", 2, "推迟")), (t("put", 3, "推迟"), t("hold", 3, "推迟"), t("push", 2, "推迟"))),
        ("照顾", "照料并满足某人的需要", (t("care", 3, "照顾"), t("tend", 2, "照顾")), (t("look", 3, "照顾"), t("care", 3, "照顾"))),
        ("解决", "找到问题的答案或处理办法", (t("solve", 3, "解决"), t("resolve", 3, "解决"), t("solution", 2, "解决")), (t("work", 3, "解决"), t("sort", 3, "妥善处理"), t("deal", 2, "解决"))),
        ("理解", "领会话语、想法或处境", (t("understand", 3, "理解"), t("comprehend", 3, "理解"), t("get", 2, "理解")), (t("make", 3, "理解"), t("take", 3, "理解"))),
        ("结束", "使过程停止或到达终点", (t("end", 3, "结束"), t("finish", 3, "结束"), t("conclude", 2, "结束")), (t("close", 2, "结束"), t("wind", 3, "结束"), t("wrap", 3, "结束"))),
        ("开始", "进入某个过程的起点", (t("begin", 3, "开始"), t("start", 3, "开始"), t("commence", 2, "开始")), (t("start", 2, "开始"), t("set", 2, "开始"), t("kick", 3, "开始"))),
        ("调查", "系统查明事实或原因", (t("investigate", 3, "调查"), t("enquiry", 2, "调查"), t("research", 2, "调查")), (t("look", 3, "调查"), t("check", 3, "调查"), t("enquire", 2, "调查"))),
        ("减少", "使数量、程度或规模变小", (t("reduce", 3, "减少"), t("decrease", 3, "减少"), t("diminish", 2, "减少")), (t("cut", 3, "减少"), t("bring", 2, "减少"), t("scale", 2, "减少（数量）"))),
        ("增加", "使数量、程度或规模变大", (t("increase", 3, "增加"), t("rise", 2, "增加"), t("boost", 2, "使增长")), (t("add", 3, "增加"), t("build", 2, "加大"), t("step", 2, "增加"))),
        ("忍受", "在不愉快情况下仍承受下去", (t("tolerate", 3, "忍受"), t("endure", 3, "忍受"), t("bear", 2, "忍受")), (t("put", 3, "忍受"), t("stand", 2, "忍受"), t("bear", 2, "容忍"))),
        ("恢复", "回到原有状态、能力或活动", (t("recover", 3, "恢复"), t("restore", 3, "恢复"), t("resume", 2, "重新开始")), (t("bounce", 3, "恢复"), t("get", 2, "恢复"), t("pick", 2, "恢复"))),
        ("成功", "达到预期目标", (t("succeed", 3, "成功"), t("success", 3, "成功"), t("achieve", 2, "成功")), (t("fly", 2, "成功"), t("make", 3, "成功"))),
        ("失败", "没有达到预期目标", (t("fail", 3, "失败"), t("failure", 3, "失败"), t("flop", 2, "失败")), (t("fall", 3, "失败"), t("break", 2, "失败"), t("come", 3, "失败"))),
        ("取消", "撤销原先的安排或决定", (t("cancel", 3, "取消"), t("abolish", 2, "废除"), t("scrap", 2, "取消")), (t("call", 3, "取消"), t("strike", 2, "取消"))),
        ("批评", "指出缺点并表示不赞成", (t("criticize", 3, "批评"), t("criticism", 3, "批评"), t("condemn", 2, "谴责")), (t("pick", 3, "挑毛病"), t("tear", 2, "批评"), t("lay", 2, "抨击"))),
        ("发现", "找到或注意到原先未知的事物", (t("discover", 3, "发现"), t("find", 3, "发现"), t("spot", 2, "发现")), (t("find", 3, "查明"), t("turn", 2, "发现"), t("come", 2, "发现"))),
    ]
    cases: list[dict[str, Any]] = []
    for index, (query, intent, sense_targets, phrase_targets) in enumerate(pairs, 1):
        group = f"scope-{index:02d}"
        leakage_group = "abandon-family" if query == "放弃" else group
        common = {
            "query": query,
            "category": "direct-translation",
            "intent": intent,
            "tags": ("scope-filter", "scope-pair", "short-query"),
            "pair_group": group,
            "leakage_group": leakage_group,
        }
        cases.append(retrieval(f"dev-{group}-sense", scopes=("sense",), targets=sense_targets, pair_role="sense", **common))
        cases.append(retrieval(f"dev-{group}-phrase", scopes=("phrase",), targets=phrase_targets, pair_role="phrase", **common))
    return cases


def source_cases() -> list[dict[str, Any]]:
    cases = _scope_pair_cases()

    single_character = [
        ("是", "判断、等同或肯定", (t("be", 3, "是"), t("yes", 2, "表示同意"), t("mean", 1, "意味着"))),
        ("要", "需要、想取得或要求", (t("want", 3, "想要"), t("need", 3, "需要"), t("require", 2, "需要"))),
        ("好", "质量良好、令人满意或状态不错", (t("good", 3, "好的"), t("fine", 2, "很好"), t("well", 2, "好"), t("OK", 2, "对；好；行"))),
        ("行", "可接受、可实行或能够运作", (t("OK", 3, "行"), t("work", 3, "奏效"), t("capable", 2, "有能力"))),
        ("开", "打开、启动或驾驶", (t("open", 3, "打开"), t("start", 2, "开始"), t("drive", 2, "开车"), t("shoot", 2, "开（枪或其他武器）"), t("prescribe", 1, "给…开（药）"))),
        ("打", "击打、击败、打电话或参加球类活动", (t("hit", 3, "打"), t("beat", 2, "打败"), t("call", 2, "打电话"), t("play", 2, "参加比赛"), t("strike", 3, "打；击"), t("shoot", 2, "打（猎物）"), t("knock", 2, "敲；击"))),
        ("上", "位于上方、向上或参加课程", (t("on", 3, "上"), t("up", 2, "向上"), t("attend", 2, "参加"))),
        ("下", "位于下方、向下或后一个", (t("down", 3, "向下"), t("under", 2, "下面"), t("next", 2, "下一个"), t("lay", 2, "下（蛋）"), t("fall", 2, "下落"), t("drop", 2, "下落"))),
        ("看", "用眼睛观察、观看或阅读", (t("look", 3, "看"), t("see", 3, "看见"), t("watch", 2, "观看"), t("read", 2, "阅读"), t("view", 3, "看；观看"), t("notice", 2, "看（或听）到；注意到"))),
        ("做", "执行、制作或从事工作", (t("do", 3, "做"), t("make", 3, "制造"), t("work", 2, "工作"))),
        ("走", "步行、离开或前往", (t("walk", 3, "走"), t("leave", 2, "离开"), t("go", 2, "去"), t("tread", 2, "行走；步行；走"))),
        ("到", "到达某地、达到某状态或直到某时", (t("arrive", 3, "到达"), t("reach", 3, "达到"), t("until", 2, "直到"), t("to", 3, "到，达（某处）"), t("into", 2, "到…里面"), t("unto", 1, "朝；向；到；对"))),
        ("给", "把某物交给他人或提供某物", (t("give", 3, "给"), t("offer", 2, "提供"), t("provide", 2, "提供"))),
        ("对", "正确、朝向或成双成对", (t("right", 3, "正确"), t("correct", 3, "正确"), t("pair", 2, "一对"))),
        ("能", "有能力或有可能做某事", (t("can", 3, "能"), t("able", 3, "能够"), t("capable", 2, "有能力"), t("could", 2, "能，可以"), t("power", 1, "能力；机会"))),
    ]
    for index, (query, intent, targets) in enumerate(single_character, 1):
        cases.append(retrieval(
            f"dev-single-{index:02d}", query, "high-frequency-polysemy", ("sense",), targets, intent,
            tags=("single-character", "high-frequency", "polysemy", "stability", "short-query", "high-recall"),
        ))

    short_direct = [
        ("马上", "立即或很快", (t("immediately", 3, "立即"), t("now", 2, "现在"), t("soon", 2, "很快"), t("straightaway", 2, "立即")), "lexical-immediate"),
        ("开心", "感到快乐和愉快", (t("happy", 3, "快乐"), t("glad", 3, "高兴"), t("pleased", 2, "高兴")), "happy-family"),
        ("生气", "感到愤怒或恼火", (t("angry", 3, "生气"), t("mad", 2, "生气"), t("annoyed", 2, "恼怒")), None),
        ("担心", "对可能发生的问题感到不安", (t("worry", 3, "担心"), t("concerned", 2, "担心"), t("anxious", 2, "担心")), None),
        ("帮忙", "提供帮助", (t("help", 3, "帮助"), t("assist", 3, "帮助"), t("aid", 2, "帮助")), None),
        ("便宜", "价格低或花费少", (t("cheap", 3, "便宜"), t("inexpensive", 3, "不昂贵"), t("low-cost", 2, "低成本")), None),
        ("可靠", "可以信赖或稳定有效", (t("reliable", 3, "可靠"), t("dependable", 3, "可靠"), t("trustworthy", 2, "可信赖")), None),
        ("准确", "没有错误且符合事实", (t("accurate", 3, "准确"), t("exact", 2, "准确"), t("precise", 2, "精确")), None),
        ("安静", "没有噪声或不受打扰", (t("quiet", 3, "安静"), t("silent", 2, "安静"), t("calm", 2, "平静")), None),
        ("危险", "可能造成伤害或损失", (t("dangerous", 3, "危险"), t("risky", 2, "危险"), t("unsafe", 2, "不安全"), t("danger", 3, "危险；风险"), t("risk", 3, "危险；风险"), t("hazard", 2, "危险；危害")), None),
    ]
    for index, (query, intent, targets, leakage_group) in enumerate(short_direct, 1):
        forbidden = (f("safe", "安全", "sense"),) if query == "危险" else ()
        cases.append(retrieval(
            f"dev-short-{index:02d}", query, "direct-translation", ("sense",), targets, intent,
            tags=("short-query", "common-vocabulary"), forbidden=forbidden, leakage_group=leakage_group,
        ))

    medium: list[dict[str, Any]] = [
        retrieval("dev-medium-01", "不知所措", "phrase-idiom", ("sense", "phrase"), (t("lost", 3, "不知所措", "sense"), t("flounder", 2, "不知所措", "sense"), t("confused", 2, "迷惑", "sense"), t("stuck", 2, "不知所措", "sense"), t("sea", 2, "困惑；茫然；不知所措", "phrase")), "面对处境时不知道怎么办", tags=("idiom",)),
        retrieval("dev-medium-02", "恰到好处", "phrase-idiom", ("sense", "phrase"), (t("apt", 3, "恰当", "sense"), t("right", 3, "恰当", "sense"), t("perfect", 2, "完美", "sense"), t("hit", 2, "恰到好处", "phrase"), t("Goldilocks", 2, "适中的；恰到好处的", "sense")), "程度、时间或方式正合适", tags=("idiom",)),
        retrieval("dev-medium-03", "视而不见", "phrase-idiom", ("sense", "phrase"), (t("ignore", 3, "不理会", "sense"), t("overlook", 2, "忽略", "sense"), t("blind", 2, "佯装不见", "phrase"), t("wink", 2, "视而不见", "phrase"), t("unheeded", 1, "遭视而不见", "sense")), "故意忽略已经看到的问题", tags=("idiom",)),
        retrieval("dev-medium-04", "一举两得", "phrase-idiom", ("sense", "phrase"), (t("kill", 3, "一举两得", "phrase"), t("win-win", 2, "双赢", "sense")), "一个行动同时取得两个结果", tags=("idiom",)),
        retrieval("dev-medium-05", "说到做到", "phrase-idiom", ("sense", "phrase"), (t("mean", 3, "说话算数", "phrase"), t("promise", 2, "承诺", "sense"), t("deliver", 2, "履行", "sense")), "兑现自己说过的话", tags=("idiom",)),
        retrieval("dev-medium-06", "随机应变", "phrase-idiom", ("sense",), (t("improvise", 3, "临时", "sense"), t("adapt", 3, "适应", "sense"), t("flexible", 2, "灵活", "sense"), t("resourceful", 3, "随机应变", "sense")), "根据变化临时调整做法", tags=("idiom",)),
        retrieval("dev-medium-07", "走投无路", "phrase-idiom", ("sense", "phrase"), (t("desperate", 3, "绝望", "sense"), t("corner", 2, "绝境", "sense"), t("nowhere", 2, "不可能找到", "phrase")), "陷入没有出路的困境", tags=("idiom",)),
        retrieval("dev-medium-08", "雪上加霜", "phrase-idiom", ("sense", "phrase"), (t("turn", 3, "雪上加霜", "phrase"), t("pile", 3, "雪上加霜", "phrase"), t("compound", 2, "使恶化", "sense"), t("rub", 3, "使雪上加霜", "phrase")), "在坏情况上再增加新的坏事", tags=("idiom",)),
        retrieval("dev-medium-09", "轻而易举", "phrase-idiom", ("sense", "phrase"), (t("easy", 3, "容易", "sense"), t("breeze", 2, "轻而易举", "sense"), t("piece", 2, "轻而易举", "phrase"), t("naturally", 2, "轻而易举", "phrase"), t("child", 2, "轻而易举", "phrase"), t("nothing", 2, "轻而易举", "phrase"), t("mess", 1, "轻而易举", "phrase")), "做起来毫不费力", tags=("idiom",)),
        retrieval("dev-medium-10", "半信半疑", "phrase-idiom", ("sense", "phrase"), (t("sceptical", 3, "怀疑", "sense"), t("skeptical", 3, "怀疑", "sense"), t("doubtful", 2, "怀疑", "sense"), t("doubt", 2, "怀疑；无把握", "sense"), t("dubious", 2, "怀疑；无把握", "sense"), t("salt", 2, "半信半疑", "phrase")), "没有完全相信", tags=("idiom",)),
        retrieval("dev-medium-11", "太离谱了", "colloquial-network", ("sense",), (t("ridiculous", 3, "荒谬", "sense"), t("absurd", 3, "荒谬", "sense"), t("outrageous", 2, "骇人听闻", "sense")), "口语中表示事情荒唐得难以接受", tags=("colloquial",)),
        retrieval("dev-medium-12", "随便你吧", "colloquial-network", ("sense", "phrase"), (t("whatever", 3, "无论什么", "sense"), t("suit", 2, "随便", "phrase"), t("up", 1, "决定", "phrase")), "把选择交给对方", tags=("colloquial",)),
        retrieval("dev-medium-13", "别催我了", "colloquial-network", ("sense",), (t("rush", 3, "急促", "sense"), t("hurry", 2, "催促", "sense"), t("pressure", 2, "催促", "sense")), "要求对方停止催促", tags=("colloquial",)),
        retrieval("dev-medium-14", "摆烂算了", "colloquial-network", ("sense", "phrase"), (t("quit", 3, "停止", "sense"), t("give", 2, "放弃", "phrase"), t("abandon", 2, "放弃", "sense")), "因不想再努力而放弃改善", tags=("colloquial", "network-expression"), forbidden=(f("persevere", "坚持", "sense"),), leakage_group="abandon-family"),
        gap("dev-medium-15", "可预测的", "morphology-derivation", ("form",), "寻找由 predict 派生的形容词", ("predictable",), absence="selected-scopes", tags=("derived-form", "scope-corpus-gap"), leakage_group="predictable-family"),
        gap("dev-medium-16", "安静离职", "corpus-gap", ("sense", "phrase"), "寻找只履行最低职责但并未辞职的职场表达", ("quiet quitting",), tags=("network-expression", "lexicalized-concept"), forbidden=(f("resign", "辞职", "sense"), f("resignation", "辞职", "sense"))),
        retrieval("dev-medium-17", "真让人下头", "colloquial-network", ("sense",), (t("off-putting", 3, "令人讨厌", "sense"), t("repellent", 2, "令人厌恶", "sense"), t("unattractive", 2, "令人反感", "sense")), "形容言行使人立刻失去好感", tags=("colloquial", "network-expression")),
        retrieval("dev-medium-18", "我彻底破防", "colloquial-network", ("sense",), (t("devastated", 3, "极为震惊", "sense"), t("upset", 2, "难过", "sense"), t("collapse", 1, "崩溃", "sense")), "口语中表示情绪防线被击穿", tags=("colloquial", "network-expression")),
        retrieval("dev-medium-19", "非常高兴", "synonym-near", ("sense",), (t("delighted", 3, "高兴", "sense"), t("thrilled", 3, "非常兴奋", "sense"), t("overjoyed", 3, "非常高兴", "sense")), "强烈的高兴情绪", tags=("intensity",), leakage_group="happy-family"),
        retrieval("dev-medium-20", "可以预测", "morphology-derivation", ("sense",), (t("predictable", 3, "可预见", "sense"), t("foreseeable", 2, "可预见", "sense"), t("expected", 2, "预期", "sense")), "寻找 predict 对应的可预见形容词及近义派生词", tags=("derived-form", "suffix"), leakage_group="predictable-family"),
        retrieval("dev-medium-21", "特别愤怒", "synonym-near", ("sense",), (t("furious", 3, "狂怒", "sense"), t("incensed", 3, "愤怒", "sense"), t("livid", 2, "暴怒", "sense"), t("apoplectic", 3, "大怒的；十分生气的", "sense"), t("irate", 3, "非常愤怒的；暴怒的", "sense"), t("mad", 2, "很生气；气愤", "sense")), "程度很强的愤怒", tags=("intensity",)),
        retrieval("dev-medium-22", "迅速增长", "synonym-near", ("sense",), (t("surge", 3, "急剧上升", "sense"), t("soar", 3, "猛增", "sense"), t("rocket", 3, "猛增", "sense")), "数量或价格在短时间内大幅增加", tags=("change-of-state",)),
        retrieval("dev-medium-23", "重新考虑", "morphology-derivation", ("sense",), (t("reconsider", 3, "重新考虑", "sense"), t("rethink", 3, "重新考虑", "sense"), t("review", 2, "审查", "sense")), "寻找带重复或再次含义的派生动词", tags=("derived-form", "prefix")),
        retrieval("dev-medium-24", "勉强同意", "synonym-near", ("sense",), (t("acquiesce", 3, "默然接受", "sense"), t("concede", 2, "承认", "sense"), t("assent", 2, "同意", "sense"), t("grant", 3, "勉强）承认，同意", "sense"), t("admit", 2, "常指勉强）承认", "sense"), t("grudging", 1, "勉强的；不情愿的", "sense"), t("begrudge", 2, "勉强做；不乐意地做", "sense")), "虽不情愿但最终接受", tags=("attitude",)),
        retrieval("dev-medium-25", "坚决反对", "synonym-near", ("sense",), (t("oppose", 3, "反对", "sense"), t("object", 3, "反对", "sense"), t("resist", 2, "抵制", "sense"), t("opposed", 3, "强烈反对", "sense"), t("opposition", 2, "强烈的）反对", "sense"), t("hostile", 2, "强烈反对", "sense"), t("veto", 2, "反对；否定", "sense")), "明确而坚定地反对", tags=("attitude",)),
        retrieval("dev-medium-26", "机器学习", "terminology", ("sense",), (t("machine learning", 3, "机器学习", "sense"),), "通过数据训练模型的计算方法", tags=("computing", "strict-term")),
        retrieval("dev-medium-27", "光合作用", "terminology", ("sense",), (t("photosynthesis", 3, "光合作用", "sense"),), "植物利用光能合成有机物的过程", tags=("biology", "strict-term")),
        retrieval("dev-medium-28", "机会成本", "terminology", ("sense",), (t("opportunity cost", 3, "机会成本", "sense"),), "选择一个方案时放弃的最佳替代收益", tags=("economics", "strict-term")),
        gap("dev-medium-29", "量子纠缠", "corpus-gap", ("sense",), "寻找量子系统之间的非经典关联术语", ("quantum entanglement",), tags=("physics", "strict-term")),
        retrieval("dev-medium-30", "免疫反应", "terminology", ("sense",), (t("immune response", 3, "免疫应答", "sense"), t("immunity", 2, "免疫", "sense")), "机体识别并应对抗原的反应", tags=("biology",)),
        retrieval("dev-medium-31", "自然选择", "terminology", ("sense",), (t("natural selection", 3, "自然选择", "sense"), t("evolution", 2, "进化", "sense")), "适应环境的性状提高繁殖机会的机制", tags=("biology",)),
        retrieval("dev-medium-32", "通货膨胀", "terminology", ("sense",), (t("inflation", 3, "通货膨胀", "sense"), t("inflationary", 2, "通货膨胀", "sense"), t("rise", 1, "上升", "sense"), t("hyperinflation", 1, "恶性通货膨胀", "sense")), "总体价格水平持续上涨", tags=("economics",), leakage_group="inflation-family"),
        retrieval("dev-medium-33", "不负责任", "morphology-derivation", ("sense",), (t("irresponsible", 3, "不负责任", "sense"), t("negligent", 2, "疏忽", "sense"), t("reckless", 1, "不计后果", "sense")), "寻找带否定前缀且表示缺乏责任感的形容词", tags=("derived-form", "prefix")),
        retrieval("dev-medium-34", "比较正式", "usage-metalanguage", ("usage",), (t("place", 3, "比 put 正式", "usage"), t("next", 3, "比较正式", "usage"), t("talk", 2, "尤指正式", "usage")), "寻找带正式语体说明的词条", tags=("evidence-ranking", "register")),
        retrieval("dev-medium-35", "常用于口语", "usage-metalanguage", ("usage",), (t("nobody", 3, "英语口语", "usage"), t("begin", 2, "常用于口语", "usage"), t("go", 2, "口语中", "usage")), "寻找口语使用说明", tags=("evidence-ranking", "register")),
        retrieval("dev-medium-36", "带贬义色彩", "usage-metalanguage", ("usage",), (t("cheap", 3, "可作贬义", "usage"), t("thin", 3, "含贬义", "usage"), t("intelligent", 2, "可能含贬义", "usage")), "寻找含贬义或不赞成色彩的说明", tags=("evidence-ranking", "connotation")),
        retrieval("dev-medium-37", "委婉的说法", "usage-metalanguage", ("usage",), (t("old", 3, "委婉语", "usage"), t("escort", 2, "委婉语", "usage"), t("piss", 2, "委婉的表达", "usage")), "寻找委婉语和礼貌替代表达", tags=("evidence-ranking", "pragmatics")),
        retrieval("dev-medium-38", "只用于名词前", "usage-metalanguage", ("usage",), (t("star", 3, "用于另一名词前", "usage"), t("colour", 3, "用于另一名词前", "usage"), t("each", 2, "用于单数名词前", "usage")), "寻找名词前位置限制说明", tags=("evidence-ranking", "grammar")),
        retrieval("dev-medium-39", "后接不定式", "usage-metalanguage", ("usage",), (t("can", 3, "不定式", "usage"), t("help", 2, "不定式", "usage"), t("try", 2, "不定式", "usage")), "寻找与不定式搭配相关的语法说明", tags=("evidence-ranking", "grammar")),
        retrieval("dev-medium-40", "我来买单", "example-fragment", ("example",), (t("pay", 3, "我来付账单", "example"), t("spring", 2, "我来付账", "example"), t("settle", 1, "我来付账", "example")), "寻找表达主动付款的例句", tags=("evidence-ranking", "spoken-example")),
        retrieval("dev-medium-41", "别挂电话", "example-fragment", ("example",), (t("hold", 3, "别挂断电话", "example"), t("hang", 3, "别挂断电话", "example"), t("line", 2, "不要挂断电话", "example")), "寻找要求对方保持通话的例句", tags=("evidence-ranking", "spoken-example")),
        retrieval("dev-medium-42", "你说得对", "example-fragment", ("example",), (t("correct", 3, "你说得对", "example"), t("right", 3, "你说得对", "example"), t("good", 2, "说得对", "example")), "寻找同意对方判断的例句", tags=("evidence-ranking", "spoken-example")),
        retrieval("dev-medium-43", "我迷路了", "example-fragment", ("example",), (t("lost", 3, "完全迷路", "example"), t("wander", 2, "迷路", "example"), t("hopeless", 1, "彻底迷路", "example")), "寻找描述迷路处境的例句", tags=("evidence-ranking", "spoken-example")),
    ]
    cases.extend(medium)

    long_mid: list[dict[str, Any]] = [
        retrieval("dev-longmid-01", "不愿意改变主意", "descriptive-reverse", ("sense",), (t("stubborn", 3, "固执", "sense"), t("obstinate", 3, "固执", "sense"), t("inflexible", 2, "固守己见", "sense")), "坚持原有意见且拒绝改变", tags=("personality",)),
        retrieval("dev-longmid-02", "让人感到难为情", "descriptive-reverse", ("sense",), (t("embarrassing", 3, "难堪", "sense"), t("awkward", 2, "尴尬", "sense")), "使人尴尬或难堪", tags=("emotion",)),
        retrieval("dev-longmid-03", "很容易被人相信", "descriptive-reverse", ("sense",), (t("believable", 3, "可信", "sense"), t("credible", 3, "可信", "sense"), t("plausible", 2, "可信", "sense")), "说法看起来可信", tags=("credibility",)),
        retrieval("dev-longmid-04", "说话绕来绕去", "descriptive-reverse", ("sense", "phrase"), (t("ramble", 3, "漫谈", "sense"), t("roundabout", 2, "间接", "sense"), t("beat", 2, "拐弯抹角", "phrase")), "表达冗长且不直接切入重点", tags=("communication",)),
        retrieval("dev-longmid-05", "只顾眼前不顾以后", "descriptive-reverse", ("sense",), (t("short-sighted", 3, "目光短浅", "sense"), t("improvident", 2, "没有长远打算", "sense")), "只考虑短期利益而忽略未来", tags=("decision-making",)),
        retrieval("dev-longmid-06", "双方都愿意让步", "descriptive-reverse", ("sense", "phrase"), (t("compromise", 3, "妥协", "sense"), t("concession", 2, "让步", "sense"), t("meet", 2, "作出让步", "phrase")), "各方调整立场以达成一致", tags=("negotiation",)),
        retrieval("dev-longmid-07", "突然变得非常成功", "descriptive-reverse", ("sense",), (t("breakthrough", 2, "重大进展", "sense"), t("meteoric", 3, "迅速成功", "sense")), "事业或产品在短时间内取得显著成功", tags=("change-of-state",)),
        retrieval("dev-longmid-08", "在背后说人坏话", "descriptive-reverse", ("sense",), (t("bad-mouth", 3, "坏话", "sense"), t("gossip", 2, "说长道短", "sense"), t("slander", 2, "诽谤", "sense"), t("backbiting", 3, "背后中伤；背后诽谤", "sense")), "在他人不在场时贬损对方", tags=("social-behaviour",)),
        retrieval("dev-longmid-09", "不是便宜而是划算", "negation-contrast", ("sense",), (t("cost-effective", 3, "划算", "sense"), t("economical", 3, "实惠", "sense")), "强调长期价值而非最低价格", tags=("contrast",), forbidden=(f("cheap", "便宜", "sense"),), leakage_group="value-not-cheap"),
        retrieval("dev-longmid-10", "并非生气只是失望", "negation-contrast", ("sense",), (t("disappointed", 3, "失望", "sense"), t("disillusioned", 2, "大失所望", "sense"), t("let-down", 2, "失望", "sense")), "表达期待落空而非愤怒", tags=("contrast",), forbidden=(f("angry", "生气", "sense"),)),
        retrieval("dev-longmid-11", "不是害怕而是谨慎", "negation-contrast", ("sense",), (t("cautious", 3, "谨慎", "sense"), t("prudent", 3, "谨慎", "sense"), t("careful", 2, "小心", "sense")), "强调审慎判断而非恐惧", tags=("contrast",), forbidden=(f("afraid", "害怕", "sense"),), leakage_group="cautious-not-risky"),
        retrieval("dev-longmid-12", "没有拒绝只是犹豫", "negation-contrast", ("sense",), (t("hesitate", 3, "犹豫", "sense"), t("indecisive", 2, "优柔寡断", "sense"), t("reluctant", 2, "不情愿", "sense")), "尚未决定而非明确回绝", tags=("contrast",), forbidden=(f("refuse", "拒绝", "sense"),)),
        retrieval("dev-longmid-13", "看似相同其实不同", "negation-contrast", ("sense",), (t("different", 3, "不同", "sense"), t("differ", 3, "不同", "sense"), t("distinction", 2, "区别", "sense")), "指出表面相似事物之间的差别", tags=("contrast",), forbidden=(f("identical", "相同", "sense"),)),
        retrieval("dev-longmid-14", "宁愿等待也不冒险", "negation-contrast", ("sense", "phrase"), (t("cautious", 3, "谨慎", "sense"), t("prudent", 2, "谨慎", "sense"), t("wait", 2, "等着瞧", "phrase")), "偏好观望并规避风险", tags=("contrast",), forbidden=(f("reckless", "鲁莽", "sense"),), leakage_group="cautious-not-risky"),
        gap("dev-longmid-15", "AI生成的假视频", "corpus-gap", ("sense",), "寻找人工智能合成真人影像的术语", ("deepfake",), tags=("mixed-input", "computing", "strict-term"), forbidden=(f("authentic", "真实", "sense"),), query_style="mixed-script"),
        retrieval("dev-longmid-16", "Wi-Fi连不上", "robustness-format", ("sense", "phrase"), (t("offline", 3, "离线", "sense"), t("connect", 3, "连接", "sense"), t("connection", 2, "连接", "sense"), t("disconnect", 3, "与互联网）断开", "sense")), "无线网络无法建立连接", tags=("mixed-input", "punctuation"), query_style="mixed-script"),
        retrieval("dev-longmid-17", "「马上」的近义词", "robustness-format", ("sense",), (t("immediately", 3, "立即", "sense"), t("straightaway", 3, "立即", "sense"), t("promptly", 2, "立即", "sense"), t("soon", 2, "很快", "sense")), "在带引号的元语言查询中寻找立即的近义表达", tags=("punctuation", "synonym-query"), leakage_group="lexical-immediate", query_style="quoted-metalanguage", is_natural_query=False),
        retrieval("dev-longmid-18", "database数据库", "robustness-format", ("sense",), (t("database", 3, "数据库", "sense"), t("databank", 2, "数据库", "sense")), "中英文重复输入下查找数据库概念", tags=("mixed-input", "redundant-script"), query_style="mixed-script", is_natural_query=False),
        gap("dev-longmid-19", "故意引战骗互动", "corpus-gap", ("sense", "phrase"), "寻找以激怒读者换取互动的内容术语", ("rage bait", "rage-bait"), tags=("network-expression", "lexicalized-concept"), forbidden=(f("harmony", "和谐", "sense"),)),
        gap("dev-longmid-20", "没名分的暧昧关系", "corpus-gap", ("sense",), "寻找未明确承诺但持续亲密交往的关系术语", ("situationship",), tags=("relationship", "lexicalized-concept"), forbidden=(f("marriage", "婚姻", "sense"),)),
        retrieval("dev-longmid-21", "通过声音判断位置", "terminology", ("sense",), (t("echolocation", 3, "回声定位", "sense"), t("sonar", 2, "声呐", "sense"), t("locate", 1, "准确位置", "sense")), "利用回声判断目标位置", tags=("science",)),
        gap("dev-longmid-22", "细胞自我吞噬过程", "corpus-gap", ("sense",), "寻找细胞降解自身成分的生物学术语", ("autophagy",), tags=("biology", "strict-term"), forbidden=(f("cannibal", "同类相食", "sense"),)),
        retrieval("dev-longmid-23", "商品价格普遍上涨", "terminology", ("sense",), (t("inflation", 3, "通货膨胀", "sense"), t("inflationary", 2, "通货膨胀", "sense"), t("rise", 2, "上升", "sense")), "总体物价持续上升", tags=("economics",), leakage_group="inflation-family"),
        retrieval("dev-longmid-24", "程序同时执行任务", "terminology", ("sense",), (t("parallel processing", 3, "并行处理", "sense"), t("parallel", 2, "并行", "sense"), t("simultaneous", 2, "同时发生", "sense"), t("multitasking", 3, "多任务处理", "sense")), "多个计算任务在重叠时间内执行", tags=("computing",)),
        retrieval("dev-longmid-25", "表示重要的各种说法", "broad-recall", ("sense",), (t("important", 3, "重要", "sense"), t("significant", 3, "重大意义", "sense"), t("crucial", 2, "至关重要", "sense"), t("essential", 2, "极其重要", "sense"), t("vital", 2, "极重要", "sense")), "高召回查找表示重要性的常用词", tags=("high-recall", "open-set")),
        retrieval("dev-longmid-26", "表示快速移动的词", "broad-recall", ("sense",), (t("rush", 3, "迅速移动", "sense"), t("dash", 3, "猛冲", "sense"), t("hurry", 2, "匆忙", "sense"), t("race", 2, "快速移动", "sense"), t("speed", 2, "快速前行", "sense")), "高召回查找快速移动相关动词", tags=("high-recall", "open-set")),
    ]
    cases.extend(long_mid)

    long_cases: list[dict[str, Any]] = [
        gap("dev-long-01", "明明会做却装不会，好把任务推给别人", "corpus-gap", ("sense", "phrase"), "寻找以假装无能逃避职责的固定概念", ("weaponized incompetence",), tags=("workplace", "lexicalized-concept"), forbidden=(f("competence", "能力", "sense"),)),
        retrieval("dev-long-02", "事情做了一半就停止，不再继续", "descriptive-reverse", ("sense", "phrase"), (t("abandon", 3, "放弃", "sense"), t("quit", 3, "停止", "sense"), t("give", 2, "停止", "phrase")), "中途停止正在进行的事情", tags=("event-description",), leakage_group="abandon-family"),
        retrieval("dev-long-03", "明知道可能失败，还是决定冒险试试", "descriptive-reverse", ("sense", "phrase"), (t("risk", 3, "冒险", "sense"), t("chance", 2, "冒险", "phrase"), t("gamble", 2, "冒险", "sense")), "在结果不确定时仍尝试", tags=("decision-making",)),
        retrieval("dev-long-04", "表面上接受意见，实际上一点没改变", "descriptive-reverse", ("sense", "phrase"), (t("lip service", 3, "口惠", "sense"), t("token", 2, "装样子", "sense"), t("superficial", 1, "表面的", "sense")), "口头赞同但没有实际行动", tags=("attitude",)),
        retrieval("dev-long-05", "别人都很紧张，他却表现得非常镇定", "descriptive-reverse", ("sense",), (t("calm", 3, "镇静", "sense"), t("composed", 3, "镇静", "sense"), t("unruffled", 2, "镇定", "sense"), t("cool", 2, "镇静", "sense")), "压力下仍保持镇定", tags=("emotion",)),
        retrieval("dev-long-06", "把复杂问题拆成几个容易处理的小部分", "descriptive-reverse", ("sense", "phrase"), (t("break", 3, "分解", "phrase"), t("decompose", 3, "分解", "sense"), t("divide", 2, "分成", "sense"), t("dissect", 2, "把…分成小块", "sense"), t("disaggregate", 3, "分解；拆解", "sense")), "把复杂整体拆解为较小部分", tags=("problem-solving",)),
        retrieval("dev-long-07", "同一个错误一再发生，让人越来越恼火", "example-scenario", ("sense",), (t("recurrent", 3, "反复出现", "sense"), t("repeat", 2, "重复", "sense"), t("exasperating", 2, "使人恼怒", "sense")), "反复问题引发持续加重的烦躁", tags=("event-description",)),
        retrieval("dev-long-08", "价格不算最低，但长期使用很值得", "descriptive-reverse", ("sense",), (t("cost-effective", 3, "划算", "sense"), t("worthwhile", 3, "值得", "sense"), t("economical", 2, "实惠", "sense"), t("value", 2, "与价格相比的）值，划算程度", "sense")), "强调全周期价值而非最低售价", tags=("decision-making",), leakage_group="value-not-cheap", forbidden=(f("cheap", "便宜", "sense"),)),
        retrieval("dev-long-09", "发言没有直接回答，故意避开关键问题", "descriptive-reverse", ("sense",), (t("evade", 3, "回避", "sense"), t("dodge", 3, "避开", "sense"), t("sidestep", 2, "回避", "sense"), t("skirt", 2, "回避", "sense"), t("hedge", 2, "避免正面回答", "sense"), t("equivocate", 3, "故意）含糊其词", "sense"), t("evasive", 2, "回避提问", "sense")), "有意绕开问题核心", tags=("communication",)),
        retrieval("dev-long-10", "只根据一次经历就对整类人下结论", "descriptive-reverse", ("sense",), (t("generalize", 3, "概括", "sense"), t("stereotype", 3, "模式化", "sense"), t("sweeping", 2, "笼统", "sense")), "用有限个例形成过度宽泛判断", tags=("reasoning",)),
    ]
    cases.extend(long_cases)
    return cases


def _open_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _candidate_rows(
    db: sqlite3.Connection,
    headword: str,
    scope: str,
    anchor: str | None,
) -> list[sqlite3.Row]:
    clauses = ["lower(headword) = lower(?)", "scope = ?"]
    values: list[str] = [headword, scope]
    if anchor:
        clauses.append("(instr(chinese_text, ?) > 0 OR instr(english_text, ?) > 0)")
        values.extend((anchor, anchor))
    return db.execute(
        "SELECT entry_id, headword, scope, candidate_text, definition_text, chinese_text, english_text, "
        "section, part, owner_id, path_json, weight "
        "FROM documents WHERE " + " AND ".join(clauses) +
        " ORDER BY weight DESC, length(chinese_text), entry_id, id",
        values,
    ).fetchall()


def _location_from_row(row: sqlite3.Row) -> dict[str, Any]:
    location: dict[str, Any] = {
        "section": row["section"],
        "path": json.loads(row["path_json"]),
    }
    if row["part"]:
        location["part"] = row["part"]
    if row["owner_id"]:
        location["ownerId"] = row["owner_id"]
    return location


def _resolve_target(db: sqlite3.Connection, case: dict[str, Any], spec: TargetSpec) -> tuple[dict[str, Any], dict[str, Any]]:
    if spec.scope:
        scope = spec.scope
    elif len(case["scopes"]) == 1:
        scope = case["scopes"][0]
    else:
        raise ValueError(f"{case['id']}: target {spec.headword!r} needs an explicit scope")
    if scope not in case["scopes"]:
        raise ValueError(f"{case['id']}: target scope {scope!r} is outside the case scopes")
    rows = _candidate_rows(db, spec.headword, scope, spec.anchor)
    if not rows:
        available = db.execute(
            "SELECT scope, chinese_text FROM documents WHERE lower(headword)=lower(?) ORDER BY scope, weight DESC LIMIT 8",
            (spec.headword,),
        ).fetchall()
        summary = [(row["scope"], row["chinese_text"][:80]) for row in available]
        raise ValueError(f"{case['id']}: no {scope} evidence for {spec.headword!r} containing {spec.anchor!r}; available={summary}")
    row = rows[0]
    relevance = {"entryId": row["entry_id"], "headword": row["headword"], "grade": spec.grade}
    evidence = {
        "entryId": row["entry_id"],
        "headword": row["headword"],
        "grade": spec.grade,
        "evidence": {
            "scope": row["scope"],
            "contains": spec.anchor,
            "location": _location_from_row(row),
        },
    }
    return relevance, evidence


def _resolve_forbidden(db: sqlite3.Connection, case: dict[str, Any], spec: ForbiddenSpec) -> dict[str, Any]:
    scopes: Iterable[str] = (spec.scope,) if spec.scope else case["scopes"]
    rows: list[sqlite3.Row] = []
    for scope in scopes:
        if scope not in case["scopes"]:
            raise ValueError(f"{case['id']}: forbidden scope {scope!r} is outside the case scopes")
        rows.extend(_candidate_rows(db, spec.headword, scope, spec.anchor))
    if not rows:
        raise ValueError(f"{case['id']}: forbidden headword has no anchored document in requested scopes: {spec.headword!r}")
    row = rows[0]
    result: dict[str, Any] = {"entryId": row["entry_id"], "headword": row["headword"], "grade": 0}
    if spec.anchor:
        result["evidence"] = {
            "scope": row["scope"],
            "contains": spec.anchor,
            "location": _location_from_row(row),
        }
    return result


def build(reverse_db: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    errors: list[str] = []
    with _open_read_only(reverse_db) as db:
        for source_case in source_cases():
            case = dict(source_case)
            relevance: list[dict[str, Any]] = []
            evidence: list[dict[str, Any]] = []
            for spec in case.pop("targetSpecs"):
                try:
                    resolved_relevance, resolved_evidence = _resolve_target(db, case, spec)
                except ValueError as error:
                    errors.append(str(error))
                    continue
                relevance.append(resolved_relevance)
                evidence.append(resolved_evidence)
            forbidden: list[dict[str, Any]] = []
            for spec in case.pop("forbiddenSpecs"):
                try:
                    forbidden.append(_resolve_forbidden(db, case, spec))
                except ValueError as error:
                    errors.append(str(error))
            case["relevance"] = relevance
            case["evidenceExpectations"] = evidence
            case["forbidden"] = forbidden
            output.append(case)
    if errors:
        raise ValueError("unresolved annotations:\n" + "\n".join(errors))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reverse-db", type=Path, default=DEFAULT_REVERSE_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="compare generated bytes with the checked-in file")
    args = parser.parse_args()
    encoded = json.dumps(build(args.reverse_db), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding="utf-8") != encoded:
            raise SystemExit(f"generated data differs from {args.output}")
        print(f"up to date: {args.output}")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
