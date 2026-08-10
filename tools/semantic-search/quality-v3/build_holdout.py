"""Build the independently sampled blind holdout for Chinese reverse search.

The source annotations below are the sole source of holdout labels.  Resolution
uses the pinned reverse-search sidecar in read-only mode and never calls a search
implementation, model, API, or quality report.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
DEFAULT_REVERSE_DB = REPOSITORY / "data" / "reverse-search.db"
DEFAULT_DEVELOPMENT = HERE / "development.json"
DEFAULT_OUTPUT = HERE / "holdout.json"
SCOPES = ("sense", "phrase", "usage", "example", "form")


@dataclass(frozen=True)
class TargetSpec:
    headword: str
    grade: int
    anchor: str
    scope: str | None = None
    candidate: str | None = None


@dataclass(frozen=True)
class ForbiddenSpec:
    headword: str
    anchor: str
    scope: str = "sense"


def t(
    headword: str,
    grade: int,
    anchor: str,
    scope: str | None = None,
    candidate: str | None = None,
) -> TargetSpec:
    return TargetSpec(headword, grade, anchor, scope, candidate)


def f(headword: str, anchor: str, scope: str = "sense") -> ForbiddenSpec:
    return ForbiddenSpec(headword, anchor, scope)


def _length_band(query: str) -> str:
    length = len(query.strip())
    for lower, upper, band in ((1, 3, "1-3"), (4, 6, "4-6"), (7, 12, "7-12"), (13, 24, "13-24")):
        if lower <= length <= upper:
            return band
    raise ValueError(f"query length is outside 1..24: {query!r} ({length})")


def retrieval(
    case_id: str,
    seed: str,
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
    query_style: str = "natural",
    natural: bool = True,
) -> dict[str, Any]:
    return {
        "id": case_id,
        "query": query,
        "split": "holdout",
        "category": category,
        "scopes": list(scopes),
        "expectation": "retrieval",
        "intent": intent,
        "tags": [f"pool-seed:{seed}", "blind-annotation", *tags],
        "queryStyle": query_style,
        "isNaturalQuery": natural,
        "queryLength": len(query.strip()),
        "lengthBand": _length_band(query),
        "auditStatus": "double-reviewed",
        "leakageAuditStatus": "development-distinct",
        "targetSpecs": list(targets),
        "forbiddenSpecs": list(forbidden),
        **({"pairGroup": pair_group, "pairRole": pair_role, "leakageGroup": pair_group} if pair_group else {}),
    }


def gap(
    case_id: str,
    seed: str,
    query: str,
    intent: str,
    missing_headwords: Sequence[str],
    *,
    scopes: Sequence[str] = ("sense", "phrase", "usage", "example"),
    absence: str = "all-scopes",
    tags: Sequence[str] = (),
) -> dict[str, Any]:
    return {
        "id": case_id,
        "query": query,
        "split": "holdout",
        "category": "corpus-gap",
        "scopes": list(scopes),
        "expectation": "gap",
        "intent": intent,
        "tags": [f"pool-seed:{seed}", "blind-annotation", "lexicalized-concept", *tags],
        "queryStyle": "natural",
        "isNaturalQuery": True,
        "queryLength": len(query.strip()),
        "lengthBand": _length_band(query),
        "auditStatus": "double-reviewed",
        "leakageAuditStatus": "development-distinct",
        "targetSpecs": [],
        "forbiddenSpecs": [],
        "gap": {"type": "corpus-gap", "absence": absence, "missingHeadwords": list(missing_headwords)},
    }


def _high_frequency_cases() -> list[dict[str, Any]]:
    rows = [
        ("A005", "过", "从一处经过另一处", (t("pass", 3, "通过"), t("cross", 2, "穿越"))),
        ("A007", "当", "担任某种职位或角色", (t("serve", 3, "任职"), t("act", 2, "充当"))),
        ("A011", "值", "价格、价值或值得", (t("value", 3, "价值"), t("worth", 3, "值得"), t("cost", 2, "价钱"))),
        ("A015", "挂", "把物品悬挂起来", (t("hang", 3, "悬挂"), t("suspend", 2, "悬"), t("hook", 2, "挂"))),
        ("A017", "面", "脸部或物体的表面", (t("face", 3, "脸"), t("surface", 3, "表面"), t("side", 2, "面"))),
        ("A019", "点", "用手指或鼠标选择", (t("click", 3, "点击"), t("tap", 2, "轻敲"), t("select", 2, "选择"))),
        ("A022", "轻", "重量小或程度较小", (t("light", 3, "轻的"), t("slight", 2, "轻微"), t("mild", 2, "轻微"))),
        ("A024", "熟", "食物已经煮熟", (t("done", 3, "熟了"), t("ripe", 2, "成熟"))),
        ("A026", "顺", "过程顺利而没有阻碍", (t("smooth", 3, "顺利"), t("successful", 2, "达到目的"), t("well", 2, "令人满意"))),
        ("A027", "怪", "奇怪或不寻常", (t("strange", 3, "奇怪"), t("odd", 3, "奇怪"), t("weird", 2, "奇异"))),
        ("A029", "方便", "便利、省事且容易使用", (t("convenient", 3, "方便"), t("handy", 2, "便利"))),
        ("A031", "东西", "物品或事物的泛称", (t("thing", 3, "东西"), t("stuff", 3, "东西"), t("object", 2, "物品"))),
        ("A033", "意思", "词语或话语的含义", (t("meaning", 3, "意思"), t("sense", 3, "含义"))),
        ("A035", "最后", "时间或顺序上的最终位置", (t("last", 3, "最后"), t("final", 3, "最后"), t("finally", 2, "最后"))),
        ("A021", "合适", "适合某个人、用途或情况", (t("suitable", 3, "合适"), t("appropriate", 3, "合适"), t("fit", 2, "适合"))),
        ("A012", "值班", "轮流在指定时间负责工作", (t("duty", 3, "值班"), t("shift", 2, "轮班"), t("watch", 2, "值班"))),
    ]
    return [
        retrieval(f"holdout-poly-{index:02d}", seed, query, "high-frequency-polysemy", ("sense",), targets, intent,
                  tags=(("single-character", "high-frequency", "polysemy", "stability", "literal-path") if len(query) == 1 else ("high-frequency", "polysemy")))
        for index, (seed, query, intent, targets) in enumerate(rows, 1)
    ]


def _scope_pair(
    index: int,
    seed: str,
    query: str,
    intent: str,
    category: str,
    sense_targets: Sequence[TargetSpec],
    phrase_targets: Sequence[TargetSpec],
) -> list[dict[str, Any]]:
    group = f"holdout-scope-{index:02d}"
    common = {"seed": seed, "query": query, "category": category, "intent": intent, "tags": ("scope-filter", "scope-pair")}
    return [
        retrieval(f"{group}-sense", scopes=("sense",), targets=sense_targets, pair_group=group, pair_role="sense", **common),
        retrieval(f"{group}-phrase", scopes=("phrase",), targets=phrase_targets, pair_group=group, pair_role="phrase", **common),
    ]


def _direct_translation_cases() -> list[dict[str, Any]]:
    pairs = [
        ("A036", "顺便", "在谈话中附带提出一个问题", (t("incidentally", 3, "顺便"), t("ask", 2, "问")), (t("way", 3, "顺便提一下", candidate="by the way"),)),
        ("A038", "及时", "在需要的时间内完成或到达", (t("timely", 3, "及时"),), (t("time", 3, "及时", candidate="in time"),)),
        ("A040", "看看", "没有明确购买目的地浏览", (t("browse", 3, "随便看看"), t("look", 2, "看")), (t("look", 3, "只是看一看", candidate="be just looking"), t("page", 2, "随意翻阅", candidate="page through"))),
        ("A041", "再想想", "暂不决定并继续考虑", (t("reconsider", 3, "重新考虑"), t("rethink", 3, "重新考虑")), (t("think", 3, "仔细考虑", candidate="think over"),)),
        ("A042", "说清楚", "把含混内容解释明确", (t("clarify", 3, "阐明"), t("explain", 2, "解释")), (t("spell", 3, "解释明白", candidate="spell out"),)),
        ("A043", "弄错了", "承认理解、辨认或操作有误", (t("mistake", 3, "误会"), t("misunderstand", 2, "误解")), (t("mix", 3, "弄错", candidate="mix up"),)),
        ("A044", "赶时间", "时间紧迫而需要快一些", (t("hurry", 3, "匆忙"), t("rush", 3, "匆忙")), (t("hurry", 3, "仓促", candidate="in a hurry"),)),
        ("A045", "不见得", "表示某个判断未必成立", (t("doubt", 3, "怀疑"), t("unlikely", 2, "不大可能")), (t("necessarily", 3, "未必", candidate="not necessarily"), t("think", 2, "我想并非如此", candidate="I don't think so"))),
        ("A046", "算了吧", "停止追究或放弃继续", (t("forget", 3, "不再想"), t("drop", 2, "放弃")), (t("let", 3, "就到此为止", candidate="let it go"),)),
    ]
    cases: list[dict[str, Any]] = []
    for index, (seed, query, intent, sense_targets, phrase_targets) in enumerate(pairs, 1):
        cases.extend(_scope_pair(index, seed, query, intent, "direct-translation", sense_targets, phrase_targets))

    rows = [
        ("A047", "有空", "询问对方现在是否有时间", (t("free", 3, "空闲"), t("available", 3, "有空"))),
        ("A048", "没关系", "表示不介意或问题不严重", (t("fine", 3, "可接受"), t("OK", 2, "对；好；行"))),
        ("A049", "没办法", "没有可行的解决办法", (t("impossible", 3, "不可能"), t("helpless", 2, "无助"), t("solution", 2, "解决办法"))),
        ("A050", "有道理", "认为某个说法合理可信", (t("reasonable", 3, "合理"), t("valid", 2, "有根据"), t("sound", 2, "合理"))),
        ("A051", "不错", "根据外观形成良好印象", (t("promising", 3, "有希望"), t("good", 2, "符合标准"), t("attractive", 2, "吸引人"))),
        ("A052", "听来不错", "根据听到的内容形成良好印象", (t("promising", 3, "有希望"), t("appealing", 2, "有吸引力"), t("good", 2, "令人满意"))),
        ("A053", "慢慢来", "劝对方不必着急", (t("relax", 3, "放松"), t("patient", 2, "耐心"))),
        ("A054", "别着急", "劝对方保持平静不要焦急", (t("calm", 3, "平静"), t("relax", 3, "放松"))),
        ("A055", "挺好的", "表示相当好并给予认可", (t("great", 3, "非常好"), t("excellent", 3, "极好的"), t("fine", 2, "很好"))),
        ("A056", "不太好", "委婉表达情况或感受不佳", (t("unwell", 3, "不舒服"), t("bad", 2, "不好"))),
        ("A057", "等一会", "要求短暂等待", (t("wait", 3, "等"), t("moment", 2, "片刻"), t("while", 2, "一会儿"))),
        ("A058", "到处", "许多地方都存在或可见", (t("everywhere", 3, "到处"), t("ubiquitous", 2, "无所不在"), t("widespread", 2, "广泛"))),
        ("A059", "明显", "某种趋势逐渐变得明显", (t("apparent", 3, "显而易见"), t("obvious", 3, "明显"), t("increasingly", 2, "越来越"))),
        ("A060", "差一点", "几乎发生或完成但最终没有", (t("almost", 3, "几乎"), t("nearly", 3, "几乎"), t("close", 2, "差一点"))),
        ("A061", "难怪会这样", "知道原因后认为结果可以理解", (t("understandable", 3, "可以理解"), t("natural", 2, "自然"), t("wonder", 2, "难怪"))),
        ("A062", "时间刚刚好", "时机或时长恰好合适", (t("timely", 3, "及时"), t("perfect", 2, "恰好"), t("exact", 2, "恰好"))),
        ("A063", "原来如此", "明白此前未知的原因或情况", (t("see", 3, "明白"), t("understand", 3, "理解"), t("realize", 2, "意识到"))),
        ("A064", "这可说不定", "表示事情仍有不确定的可能", (t("maybe", 3, "也许"), t("possibly", 2, "可能"), t("uncertain", 2, "不确定"))),
        ("A065", "我不得不去", "受条件限制而必须去", (t("must", 3, "必须"), t("have", 3, "不得不"), t("obliged", 2, "不得不"))),
        ("A066", "以后用得上", "以后能够派上用场", (t("useful", 3, "有用"), t("handy", 3, "有用"), t("practical", 2, "实用"))),
        ("A067", "这个人靠得住", "形容某人可靠而值得信任", (t("reliable", 3, "可靠"), t("dependable", 3, "可靠"), t("trustworthy", 2, "可信赖"))),
        ("A068", "跟得上进度", "能够追上既定进度或节奏", (t("keep", 3, "跟上"), t("pace", 2, "步调"), t("catch", 2, "赶上"))),
        ("A069", "先放轻松点", "劝人缓解紧张并放松", (t("relax", 3, "放松"), t("calm", 2, "平静"), t("easy", 2, "放松"))),
        ("A070", "系统出问题", "系统发生故障或不能正常工作", (t("malfunction", 3, "故障"), t("fail", 2, "出故障"), t("problem", 2, "问题"))),
    ]
    for index, (seed, query, intent, targets) in enumerate(rows[:14], 1):
        cases.append(retrieval(f"holdout-direct-{index:02d}", seed, query, "direct-translation", ("sense",), targets, intent))

    extra_pairs = [
        ("C031/C032", "采取措施", "采取行动以处理问题", (t("measure", 3, "措施"), t("action", 2, "行动")), (t("step", 3, "采取措施", candidate="step up to the plate"),)),
        ("C033/C034", "得出结论", "经过分析后形成判断", (t("conclude", 3, "得出结论"), t("conclusion", 3, "结论")), (t("arrive", 3, "得出", candidate="arrive at"),)),
        ("C035/C036", "不惜代价", "为了目标愿意付出很大代价", (t("cost", 3, "代价"), t("sacrifice", 2, "牺牲")), (t("cost", 3, "不惜任何代价", candidate="at all costs"),)),
        ("C037/C038", "与其说", "比较两种说法并突出后一种", (t("rather", 3, "而是"), t("comparison", 2, "比较")), (t("rather", 3, "而不是", candidate="rather than"),)),
        ("C039/C040", "根本不", "加强否定并完全排除某种判断", (t("utterly", 3, "完全"), t("scarcely", 2, "根本不")), (t("anything", 3, "根本不", candidate="anything but"), t("means", 3, "绝不", candidate="by no means"))),
    ]
    for offset, (seed, query, intent, sense_targets, phrase_targets) in enumerate(extra_pairs, 10):
        cases.extend(_scope_pair(offset, seed, query, intent, "direct-translation", sense_targets, phrase_targets))
    return cases


def _descriptive_cases() -> list[dict[str, Any]]:
    rows = [
        ("B046", "想找一个形容说话总是绕弯子不直接的词", "表达不直接并不断铺垫或暗示", (t("indirect", 3, "间接"), t("roundabout", 3, "迂回"), t("evasive", 2, "回避"))),
        ("B047", "明明很在意却努力装作自己毫不在意", "表面装作无所谓而内心在意", (t("pretend", 3, "假装"), t("indifferent", 2, "漠不关心"), t("nonchalant", 2, "若无其事"))),
        ("B048", "无论遇到什么人都能够一直保持耐心", "面对各种人都温和且不轻易烦躁", (t("patient", 3, "有耐心"), t("tolerant", 2, "宽容"), t("understanding", 2, "善解人意"))),
        ("B049", "再小的事情也一定要认真追究个明白", "对细节和小问题也认真追究", (t("meticulous", 3, "细心"), t("fussy", 2, "挑剔"), t("pedantic", 2, "迂腐"))),
        ("B050", "自己明明不懂却偏偏还要装作很懂", "缺乏知识却故意表现得很懂", (t("pretentious", 3, "虚夸"), t("bluff", 2, "虚张声势"), t("know-all", 2, "无所不知"))),
        ("B051", "只要周围人一多就会觉得拘束不自在", "在人群中感到拘束而不自然", (t("self-conscious", 3, "局促不安"), t("uncomfortable", 3, "不自在"), t("awkward", 2, "尴尬"))),
        ("B052", "做任何事情都安排得清楚而且有条有理", "处理事情顺序清楚且组织得当", (t("organized", 3, "有条理"), t("methodical", 3, "有条理"), t("systematic", 2, "有条理"))),
        ("B053", "嘴上已经答应了行动上却总是一拖再拖", "口头同意却迟迟不落实", (t("stall", 3, "拖延"), t("procrastinate", 3, "拖延"), t("delay", 2, "推迟"))),
        ("B054", "自己没什么主见很容易被别人的意见带着走", "缺少独立判断并容易受他人影响", (t("impressionable", 3, "易受影响"), t("suggestible", 3, "易受他人影响"), t("pliant", 2, "容易摆布"))),
        ("B055", "明明是自己做错了却还一直找各种借口", "犯错后找理由推脱责任", (t("excuse", 3, "借口"), t("evade", 2, "逃避"), t("deflect", 2, "转移"))),
        ("B056", "外表看起来很普通却有一种很强的气场", "外表普通却有强烈存在感", (t("charismatic", 3, "超凡魅力"), t("imposing", 3, "使人印象深刻"), t("striking", 2, "引人注目"))),
        ("B057", "第一眼看起来冷冷的好像很难让人接近", "给人严肃疏离而难以接近的印象", (t("unapproachable", 3, "难接近"), t("aloof", 3, "冷漠"), t("distant", 2, "疏远"))),
        ("B058", "每次跟人聊天都能很快把整个话题聊死", "回应方式让对话难以继续", (t("uncommunicative", 3, "不爱说话"), t("taciturn", 2, "沉默寡言"), t("abrupt", 2, "生硬"))),
        ("B059", "表面上对谁都热情其实内心一直很疏离", "外在亲切而情感上保持距离", (t("detached", 3, "不带感情"), t("superficial", 2, "表面的"), t("insincere", 2, "不诚恳"))),
        ("B060", "一紧张就说不清楚", "紧张时难以清楚组织语言", (t("inarticulate", 3, "不善于表达"), t("tongue-tied", 3, "张口结舌"))),
        ("B061", "事情越多反而越冷静", "压力增加时仍能镇定处理局面", (t("composed", 3, "镇静"), t("calm", 3, "镇静"), t("unflappable", 2, "镇定"))),
        ("B062", "遇到误解也不爱解释自己", "面对误解时较少主动辩解", (t("reticent", 3, "不愿与人交谈"), t("reserved", 3, "寡言少语"), t("private", 2, "不爱交流"))),
        ("B063", "一开口说话就停不下来", "打开话题后持续说很多话", (t("talkative", 3, "健谈"), t("chatty", 3, "健谈"), t("garrulous", 2, "饶舌"))),
        ("B064", "总能注意到很细小的变化", "迅速注意细微差异和问题", (t("observant", 3, "善于观察"), t("perceptive", 3, "有洞察力"), t("sensitive", 2, "敏感"))),
        ("B065", "不说关心的话却会默默去做", "少用语言表达而以行动关心", (t("reserved", 2, "矜持"), t("considerate", 3, "体贴"), t("caring", 3, "关心"))),
        ("B066", "什么事情都想由自己掌控", "强烈希望决定过程和结果", (t("domineering", 3, "专断"), t("possessive", 2, "占有欲"))),
        ("B067", "刚认识时很难马上热络起来", "需要时间才能与陌生人熟悉亲近", (t("reserved", 3, "矜持"), t("shy", 2, "羞怯"), t("distant", 2, "疏远"))),
        ("B068", "即使需要帮助也总怕麻烦别人", "担心增加他人负担而不愿求助", (t("considerate", 3, "体谅"), t("reluctant", 2, "不情愿"), t("self-reliant", 2, "自力更生"))),
        ("B069", "回答总是没有回应问题重点", "回答偏离问题重点或有意回避", (t("irrelevant", 3, "不相关"), t("evasive", 3, "回避"), t("unresponsive", 2, "未答复"))),
    ]
    return [retrieval(f"holdout-descriptive-{index:02d}", seed, query, "descriptive-reverse", ("sense",), targets, intent)
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _phrase_cases() -> list[dict[str, Any]]:
    rows = [
        ("B091", "说曹操曹操到", "刚提到某人对方就恰好出现", (t("devil", 3, "说到某人", "phrase", "speak of the devil"),)),
        ("B092", "有一说一", "坦率而实事求是地评价", (t("frank", 3, "坦率", "sense"),)),
        ("B094", "得了便宜还卖乖", "已经获益却仍装作委屈或不满足", (t("advantage", 3, "占…的便宜", "phrase", "take advantage"), t("smug", 2, "自鸣得意", "sense"), t("ungrateful", 2, "不领情", "sense"))),
        ("B095", "嘴硬心软", "言语强硬而内心善良容易体谅", (t("soft-hearted", 3, "心肠软", "sense"), t("tough", 2, "强硬", "sense"))),
        ("B096", "话里有话", "话语表面之外还含有暗示", (t("hidden", 2, "隐藏的", "sense"), t("implication", 3, "含意", "sense"))),
        ("B097", "临时抱佛脚", "到最后关头才匆忙准备", (t("cram", 3, "临时死记硬背", "sense"), t("improvise", 2, "临时", "sense"))),
        ("B098", "吃一堑长一智", "经历挫折后吸取教训变得谨慎", (t("lesson", 3, "教训", "sense"), t("cautious", 2, "谨慎", "sense"), t("experienced", 2, "有经验", "sense"))),
        ("B099", "赶鸭子上架", "没有准备却被迫承担任务", (t("force", 3, "迫使", "sense"), t("unprepared", 2, "无准备", "sense"))),
        ("B100", "借坡下驴", "利用机会顺势退让并结束尴尬", (t("climb", 3, "认错", "phrase", "climb down"), t("retreat", 2, "撤退", "sense"))),
        ("B101", "打肿脸充胖子", "条件不足却硬要装作有实力", (t("appearance", 3, "装样子", "phrase", "keep up appearances"), t("pretend", 2, "假装", "sense"), t("show-off", 2, "炫耀", "sense"))),
        ("B102", "一个愿打一个愿挨", "双方都自愿参与这种关系", (t("tango", 3, "一个巴掌拍不响", "phrase", "it takes two to tango"), t("mutual", 2, "相互的", "sense"), t("willing", 2, "愿意", "sense"))),
        ("B105", "吃不了兜着走", "做错事后将承担严重后果", (t("consequence", 3, "后果", "sense"), t("pay", 2, "付代价", "phrase", "pay the price"))),
        ("B106", "踩着点到", "恰好在约定时间到达而没有提前量", (t("time", 3, "准时", "phrase", "on time"), t("nick", 3, "在最后一刻", "phrase", "in the nick of time"), t("punctual", 2, "准时", "sense"))),
        ("B107", "话说得太满", "承诺或判断过于绝对", (t("absolute", 3, "绝对的", "sense"), t("premature", 2, "过早", "sense"))),
        ("B108", "拣了芝麻丢了西瓜", "为小利益而失去更重要的目标", (t("short-sighted", 3, "目光短浅", "sense"), t("priority", 2, "优先事项", "sense"), t("foolish", 2, "愚蠢", "sense"))),
        ("B109", "新官上任三把火", "新任者起初积极采取措施", (t("proactive", 3, "积极主动", "sense"), t("energetic", 2, "精力充沛", "sense"), t("reform", 2, "改革", "sense"))),
    ]
    cases = []
    for index, (seed, query, intent, targets) in enumerate(rows, 1):
        scopes = tuple(dict.fromkeys(target.scope or "sense" for target in targets))
        cases.append(retrieval(f"holdout-phrase-{index:02d}", seed, query, "phrase-idiom", scopes, targets, intent, tags=("idiom",)))
    return cases


def _terminology_cases() -> list[dict[str, Any]]:
    rows = [
        ("C005", "信念行为矛盾的认知失调", "信念和行为矛盾造成的心理不适", (t("cognitive dissonance", 3, "认知失调"), t("dissonance", 2, "不一致"))),
        ("C011", "财报里的资产负债表", "列示资产负债和所有者权益的报表", (t("balance sheet", 3, "资产负债表"), t("statement", 2, "报表"))),
        ("C012", "现金流量", "资金流入和流出的金额及变化", (t("cash flow", 3, "现金流"),)),
        ("C013", "通货紧缩", "总体物价持续下降的经济现象", (t("deflation", 3, "通货紧缩"),)),
        ("C014", "基因突变", "遗传物质发生的可遗传改变", (t("mutation", 3, "突变"), t("mutate", 2, "变异"))),
        ("C020", "折射率", "描述光在介质中传播速度变化的参数", (t("refractive index", 3, "折射率"),)),
        ("C023", "版权侵权", "未经授权使用受版权保护作品", (t("breach", 3, "侵犯版权", "example"), t("infringe", 3, "侵犯版权", "example"))),
        ("C024", "合同违约", "一方没有按照合同履行义务", (t("breach", 3, "违约", "example"), t("default", 2, "违约", "sense"))),
        ("C025", "无罪推定", "被依法证明有罪前应当视为无罪", (t("presumption", 3, "应被假定无罪", "example"), t("presume", 2, "证明有罪前假定为无罪", "example"))),
        ("C026", "利益冲突", "不同利益影响公正判断的情况", (t("conflict", 3, "利益", "phrase", "conflict of interest"), t("clash", 2, "利益冲突", "example"))),
        ("C027", "文艺复兴", "欧洲重视古典文化和人文思想的历史运动", (t("renaissance", 3, "文艺复兴", "sense"),)),
        ("C028", "可持续发展", "兼顾资源环境和长期需要的发展方式", (t("development", 3, "可持续发展", "example"), t("sustainable", 2, "可持续的", "sense"))),
        ("C029", "碳足迹", "活动或产品产生的温室气体排放量", (t("carbon footprint", 3, "碳足迹", "sense"),)),
        ("C030", "供应链", "生产运输和供货环节组成的链条", (t("supply chain", 3, "供应链", "sense"),)),
    ]
    cases = []
    for index, (seed, query, intent, targets) in enumerate(rows, 1):
        scopes = tuple(dict.fromkeys(target.scope or "sense" for target in targets))
        cases.append(retrieval(f"holdout-term-{index:02d}", seed, query, "terminology", scopes, targets, intent, tags=("strict-term",)))
    return cases


def _gap_cases() -> list[dict[str, Any]]:
    rows = [
        ("C101", "焦虑内耗", "反复焦虑思考并持续消耗精力", ("mental friction",)),
        ("C102", "互动里提供情绪价值", "互动中给予理解陪伴和情感满足", ("emotional value",)),
        ("C103", "断舍离", "主动舍弃不需要的物品和关系以简化生活", ("danshari",)),
        ("C104", "松弛感", "从容自然且不紧绷的状态或气质", ("relaxed vibe",)),
        ("C105", "躺平", "降低竞争投入并选择低欲望生活", ("lying flat",)),
        ("C106", "社恐", "网络口语中对强烈社交紧张和回避的简称", ("social fear",)),
        ("C107", "聊天消息已读却不回复", "看到消息后有意不作回复", ("left on read",)),
        ("C108", "整活", "故意制造新奇逗趣内容来吸引注意", ("content stunt",)),
        ("C109", "内卷", "竞争投入不断加码而整体收益没有增加", ("involutionary competition",)),
        ("C110", "治愈系", "能带来安慰温暖和舒缓感受的风格", ("healing aesthetic",)),
    ]
    return [gap(f"holdout-gap-{index:02d}", seed, query, intent, missing, tags=("gap-reviewed",))
            for index, (seed, query, intent, missing) in enumerate(rows, 1)]


def _colloquial_cases() -> list[dict[str, Any]]:
    rows = [
        ("B001", "一下子就被整破防了", "因触动或冲击而情绪失守", (t("devastated", 3, "极为震惊"), t("emotional", 2, "情绪激动"))),
        ("B002", "当场尴尬到想逃走", "在公开场合遭遇极度尴尬", (t("embarrassed", 3, "尴尬"),)),
        ("B003", "这件事干脆摆烂算了", "主动放弃改善并消极应付", (t("quit", 3, "停止"), t("abandon", 2, "放弃"), t("apathetic", 2, "冷漠"))),
        ("B004", "越看越上头停不下来", "因兴奋沉迷而失去冷静", (t("excited", 3, "兴奋"), t("obsession", 2, "痴迷"))),
        ("B005", "上班的时候偷偷摸鱼", "工作或学习期间偷闲做无关的事", (t("slack", 3, "偷懒"), t("loaf", 3, "闲荡"), t("idle", 2, "无所事事"))),
        ("B006", "总是在心里反复内耗", "反复自我怀疑和心理拉扯造成精力消耗", (t("overthink", 3, "过度思虑"), t("drain", 2, "消耗"))),
        ("B007", "已读不回", "看过消息却没有回复", (t("ignore", 3, "不理会"), t("unanswered", 3, "未回答"), t("unresponsive", 2, "未答复"))),
        ("B008", "约好的事情临时鸽了", "临时取消已经答应的约定", (t("cancel", 3, "取消"), t("ditch", 2, "抛弃"), t("renege", 2, "食言"))),
        ("B009", "心思完全被对方拿捏了", "弱点或偏好被对方掌握并控制", (t("manipulate", 3, "操纵"), t("control", 3, "控制"), t("exploit", 2, "利用"))),
        ("B010", "这个行业竞争实在太卷了", "竞争过度激烈并不断加码", (t("competitive", 3, "竞争的"), t("cut-throat", 3, "竞争激烈"), t("pressure", 2, "压力"))),
        ("B016", "我先撤了", "随意地表示自己先离开当前场合", (t("leave", 3, "离开"), t("go", 2, "离开"), t("depart", 2, "离开"))),
        ("B012", "打工人", "带自嘲意味的普通上班者", (t("office worker", 3, "上班族"), t("employee", 2, "雇员"), t("worker", 2, "工作者"))),
        ("B013", "全网无代餐", "找不到可以替代的对象或体验", (t("irreplaceable", 3, "不能替代"), t("unique", 2, "独一无二"), t("unrivalled", 2, "无可匹敌"))),
        ("B014", "这个意外情况把我整不会了", "面对意外局面感到困惑而无从处理", (t("confused", 3, "迷惑"), t("lost", 2, "不知所措"))),
    ]
    return [retrieval(f"holdout-colloquial-{index:02d}", seed, query, "colloquial-network", ("sense",), targets, intent, tags=("colloquial",))
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _negation_cases() -> list[dict[str, Any]]:
    rows = [
        ("B026", "我表达的重点并不是生气而是期待落空后的失望", "强调期待落空而排除愤怒", (t("disappointed", 3, "失望"), t("disillusioned", 2, "大失所望"), t("let-down", 2, "失望")), (f("angry", "生气"),)),
        ("B027", "表达立场时我不想显得太强势但也不是没有主见", "避免压迫感并保留明确立场", (t("assertive", 3, "坚定自信"), t("tactful", 3, "圆通"), t("diplomatic", 2, "策略")), (f("domineering", "专断"),)),
        ("B028", "任务没有推进不是因为拖延而是确实遇到障碍卡住了", "因障碍无法推进而排除故意拖延", (t("stuck", 3, "卡住"), t("obstacle", 2, "障碍")), (f("procrastinate", "拖延"),)),
        ("B029", "这段话我想写得随和一些但不想显得太正式", "需要自然随和而排除正式语体", (t("informal", 3, "非正式"), t("casual", 3, "随便"), t("relaxed", 2, "自在")), (f("formal", "正式"),)),
        ("B030", "我只是羡慕别人拥有的东西并不是心怀恶意的嫉妒", "欣赏他人拥有之物而排除嫉妒", (t("envious", 3, "羡慕"), t("appreciative", 2, "欣赏")), (f("jealous", "妒忌"),)),
        ("B031", "他待人并不冷淡无礼只是一直保持着一定的距离感", "礼貌但疏离而排除冷漠无礼", (t("reserved", 3, "矜持"), t("distant", 3, "疏远"), t("aloof", 2, "冷淡")), (f("rude", "无礼"),)),
        ("B032", "这个东西价格并不昂贵但是外观看起来精致又高级", "价格不高但显得有品质", (t("elegant", 3, "雅致"), t("stylish", 3, "时髦"), t("refined", 2, "优雅")), (f("expensive", "昂贵"),)),
        ("B033", "我只是想礼貌提醒一下进度并不想让对方觉得在催", "提醒进度但避免施压催促", (t("remind", 3, "提醒"), t("follow-up", 3, "后续"), t("tactful", 2, "圆通")), (f("pressure", "逼迫"),)),
        ("B034", "现在只是暂缓推进并不是已经明确拒绝以后继续合作", "暂时搁置而排除彻底拒绝", (t("defer", 3, "推迟"), t("postpone", 3, "推迟"), t("pending", 2, "待定")), (f("refuse", "拒绝"),)),
        ("B035", "这个人看着很随和但关键问题上有原则并不软弱", "随和但坚定且有原则", (t("principled", 3, "原则性强"), t("firm", 3, "坚定"), t("resolute", 2, "有决心")), (f("weak", "软弱"),)),
    ]
    return [retrieval(f"holdout-negation-{index:02d}", seed, query, "negation-contrast", ("sense",), targets, intent,
                      tags=("contrast",), forbidden=forbidden)
            for index, (seed, query, intent, targets, forbidden) in enumerate(rows, 1)]


def _usage_cases() -> list[dict[str, Any]]:
    rows = [
        ("C041", "可数", "寻找说明名词可以计数的用法证据", (t("many", 3, "只与可数名词", "usage"), t("less", 2, "与可数名词连用", "usage"))),
        ("C042", "不可数", "寻找说明名词通常不可计数的用法证据", (t("advice", 3, "不可数名词", "usage"), t("evidence", 2, "不可数名词", "usage"))),
        ("C048", "正式说法", "寻找正式书面或工作场合的用语说明", (t("affect", 3, "正式", "usage"), t("approximately", 2, "最正式", "usage"))),
        ("C049", "口语表达", "寻找适合日常交谈的用语说明", (t("begin", 3, "口语", "usage"), t("almost", 2, "多用于口语", "usage"))),
        ("C050", "讽刺语气", "寻找带讽刺意味的语用说明", (t("glad", 3, "讽刺", "usage"),)),
        ("C051", "贬义用法", "寻找带负面评价色彩的用法说明", (t("cheap", 3, "贬义", "usage"), t("thin", 2, "贬义", "usage"))),
        ("C052", "委婉说法", "寻找避免直接尖锐表达的委婉说明", (t("old", 3, "委婉", "usage"), t("escort", 2, "委婉", "usage"))),
        ("C053", "固定搭配", "寻找词语之间稳定组合的搭配说明", (t("action", 3, "搭配", "usage"), t("make", 2, "搭配", "usage"))),
        ("C054", "后置定语", "寻找位于名词后面的修饰语说明", (t("aside", 3, "用于名词后", "usage"), t("content", 2, "用于名词后", "usage"))),
        ("C044", "过去完成时", "寻找表示过去某时之前已完成动作的时态", (t("the past perfect", 3, "过去完成时", "sense"),)),
    ]
    cases = []
    for index, (seed, query, intent, targets) in enumerate(rows, 1):
        scopes = tuple(dict.fromkeys(target.scope or "usage" for target in targets))
        cases.append(retrieval(f"holdout-usage-{index:02d}", seed, query, "usage-metalanguage", scopes, targets, intent, tags=("evidence-ranking",)))
    return cases


def _synonym_cases() -> list[dict[str, Any]]:
    rows = [
        ("B076", "比喜欢更强一点", "强度高于一般喜欢但未达到痴迷", (t("adore", 3, "热爱"), t("fond", 2, "喜欢"), t("keen", 2, "喜爱"))),
        ("B077", "轻微不耐烦", "有一点烦躁但没有明显发火", (t("impatient", 3, "不耐烦"), t("irritated", 2, "恼怒"), t("restless", 2, "不耐烦"))),
        ("B078", "有礼貌但不亲近", "态度得体却保持关系距离", (t("civil", 3, "有礼貌"), t("reserved", 2, "矜持"))),
        ("B079", "有点心动但还没有到真正喜欢的程度", "短暂被吸引但尚未形成稳定喜欢", (t("attraction", 3, "吸引力"), t("interested", 2, "感兴趣"), t("fond", 2, "喜欢"))),
        ("B080", "佩服又有点怕", "敬重对方能力同时略感畏惧", (t("awe", 3, "敬畏"), t("intimidated", 3, "胆怯"), t("admire", 2, "钦佩"))),
        ("B081", "温柔但不软弱", "待人柔和同时有力量和立场", (t("gentle", 3, "温柔"), t("tender", 2, "温柔"), t("strong", 2, "坚强"))),
        ("B082", "礼貌地表示不满", "克制得体地表达异议或不高兴", (t("protest", 3, "抗议"), t("object", 3, "反对"), t("complain", 2, "抱怨"))),
        ("B083", "很想要但不敢开口", "有明显愿望却因顾虑不敢提出", (t("long", 3, "渴望"), t("yearn", 3, "渴望"), t("hesitant", 2, "犹豫"))),
    ]
    return [retrieval(f"holdout-synonym-{index:02d}", seed, query, "synonym-near", ("sense",), targets, intent, tags=("degree",))
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _morphology_cases() -> list[dict[str, Any]]:
    rows = [
        ("C028", "可持续的", "寻找 sustain 派生的形容词", (t("sustainable", 3, "可持续"), t("renewable", 2, "可再生"))),
        ("B077", "不耐烦的", "寻找带否定前缀且表示缺少耐心的形容词", (t("impatient", 3, "不耐烦"), t("restless", 2, "不耐烦"))),
        ("A083", "听错了", "寻找表示误听的派生动词", (t("mishear", 3, "听错"), t("misunderstand", 2, "误解"))),
        ("A091", "看错了", "寻找表示误读或看错的派生动词", (t("misread", 3, "读错"), t("mistake", 2, "看错"))),
        ("A076", "重新安排", "寻找带再次含义的安排动词", (t("reschedule", 3, "重新安排"), t("rearrange", 3, "重新安排"))),
        ("B090", "降低预期", "寻找表示向下调整预期的派生表达", (t("downgrade", 3, "降低"), t("lower", 2, "降低"))),
    ]
    return [retrieval(f"holdout-morph-{index:02d}", seed, query, "morphology-derivation", ("sense",), targets, intent, tags=("derived-form",))
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _example_cases() -> list[dict[str, Any]]:
    rows = [
        ("C066", "差点没赶上飞机", "寻找描述险些没赶上航班的例句", (t("miss", 3, "赶不上飞机", "example"), t("almost", 2, "差点", "example"))),
        ("C067", "到站后给我打电话", "寻找到达后联系对方的例句", (t("call", 3, "给我打电话", "example"), t("arrive", 2, "到站", "example"))),
        ("C068", "雨下得越来越大", "寻找描述降雨增强的例句", (t("rain", 3, "雨", "example"),)),
        ("C069", "他看起来有点失望", "寻找根据外表判断失望的例句", (t("disappointed", 3, "失望", "example"), t("look", 2, "看起来", "example"))),
        ("C070", "临时取消了会议", "寻找会议突然取消的例句", (t("cancel", 3, "取消", "example"), t("meeting", 2, "会议", "example"))),
        ("C071", "把门轻轻关上", "寻找轻声关门的例句", (t("close", 3, "关上", "example"), t("gently", 2, "轻轻", "example"))),
        ("C072", "我已经习惯早起", "寻找已经适应早起的例句", (t("used", 3, "习惯", "example"),)),
        ("C073", "这家店值得一试", "寻找推荐尝试店铺的例句", (t("worth", 3, "值得", "example"), t("try", 2, "试", "example"))),
    ]
    return [retrieval(f"holdout-example-{index:02d}", seed, query, "example-fragment", ("example",), targets, intent, tags=("evidence-ranking",))
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _robustness_cases() -> list[dict[str, Any]]:
    rows = [
        ("C081", "临 时 取消", "忽略误插空格后理解为临时取消", (t("cancel", 3, "取消"), t("postpone", 2, "推迟"))),
        ("C082", "说来,话长", "忽略半角标点后理解事情难以简短说明", (t("complicated", 3, "复杂"), t("lengthy", 2, "冗长"))),
        ("C083", "一举获得两种好处？", "忽略末尾问号后理解一个行动取得两个结果", (t("win-win", 3, "双赢"), t("double", 2, "双重"))),
        ("C084", "take it easy放轻松", "中英文混输下理解放松意图", (t("relax", 3, "放松"),)),
        ("C085", "out of date过时", "中英文混输下理解过时意图", (t("outdated", 3, "过时"), t("obsolete", 3, "过时"))),
        ("C086", "邮件地址，", "忽略尾随标点后理解电子邮件地址", (t("email", 3, "电子邮件"), t("address", 2, "地址"))),
    ]
    return [retrieval(f"holdout-robust-{index:02d}", seed, query, "robustness-format", ("sense",), targets, intent,
                      tags=("format-noise",), query_style="format-noise", natural=False)
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _broad_cases() -> list[dict[str, Any]]:
    rows = [
        ("C093", "表达同意", "寻找多种表示赞同的常用表达", (t("agree", 3, "同意"), t("approve", 2, "赞成"), t("consent", 2, "同意"), t("accept", 2, "接受"))),
        ("C094", "表达拒绝", "寻找多种直接或礼貌拒绝的表达", (t("refuse", 3, "拒绝"), t("reject", 3, "拒绝"), t("decline", 2, "谢绝"), t("deny", 2, "拒绝"))),
        ("C096", "表示惊讶", "寻找表达惊讶情绪的不同说法", (t("surprised", 3, "惊讶"), t("astonished", 3, "惊讶"), t("amazed", 2, "大为惊奇"))),
        ("C097", "安慰别人", "寻找安慰低落者的常用表达", (t("comfort", 3, "安慰"), t("console", 3, "安慰"), t("reassure", 2, "使…安心"), t("encourage", 2, "鼓励"))),
    ]
    return [retrieval(f"holdout-broad-{index:02d}", seed, query, "broad-recall", ("sense",), targets, intent, tags=("high-recall", "open-set"))
            for index, (seed, query, intent, targets) in enumerate(rows, 1)]


def _scenario_cases() -> list[dict[str, Any]]:
    rows = [
        ("C074", "准备出门时突然想起还没有提醒对方带上充电器", "在临行前提醒携带容易遗漏的物品", (t("remind", 3, "提醒"), t("forget", 2, "忘记"), t("charger", 2, "充电器"))),
        ("C075", "大家已经按原计划准备好了她却突然改变了自己的主意", "在已有安排后忽然作出不同决定", (t("reconsider", 3, "重新考虑"), t("rethink", 2, "重新考虑"), t("alter", 2, "改变"))),
        ("C077", "每次别人还没有说完他就急着插话打断对方", "反复在他人说完之前插话", (t("interrupt", 3, "插嘴", "sense"), t("interject", 2, "插话", "sense"), t("butt", 2, "插嘴", "example"))),
        ("C078", "真正开始处理以后才发现事情远比原先想象的复杂", "实际难度超过最初预期", (t("complicated", 3, "复杂"), t("difficult", 2, "困难"), t("underestimate", 2, "低估"))),
    ]
    cases = []
    for index, (seed, query, intent, targets) in enumerate(rows, 1):
        scopes = tuple(dict.fromkeys(target.scope or "sense" for target in targets))
        cases.append(retrieval(f"holdout-scenario-{index:02d}", seed, query, "example-scenario", scopes, targets, intent, tags=("event-description",)))
    return cases


def source_cases() -> list[dict[str, Any]]:
    return [
        *_high_frequency_cases(),
        *_direct_translation_cases(),
        *_descriptive_cases(),
        *_phrase_cases(),
        *_terminology_cases(),
        *_gap_cases(),
        *_colloquial_cases(),
        *_negation_cases(),
        *_usage_cases(),
        *_synonym_cases(),
        *_morphology_cases(),
        *_example_cases(),
        *_robustness_cases(),
        *_broad_cases(),
        *_scenario_cases(),
    ]


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
    anchor: str,
    candidate: str | None,
) -> list[sqlite3.Row]:
    clauses = ["lower(headword) = lower(?)", "scope = ?", "(instr(chinese_text, ?) > 0 OR instr(english_text, ?) > 0)"]
    values: list[str] = [headword, scope, anchor, anchor]
    return db.execute(
        "SELECT id, entry_id, headword, scope, candidate_text, definition_text, chinese_text, english_text, "
        "section, part, owner_id, path_json, weight FROM documents WHERE " + " AND ".join(clauses) +
        " ORDER BY weight DESC, length(chinese_text), entry_id, id",
        values,
    ).fetchall()


def _candidate_tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold().replace("ˈ", "").replace("ˌ", "")
    return [token for token in re.findall(r"[a-z0-9]+", normalized) if token not in {"sb", "sth", "etc"}]


def _candidate_matches(actual: str, expected: str) -> bool:
    actual_tokens = iter(_candidate_tokens(actual))
    return all(any(token == expected_token for token in actual_tokens) for expected_token in _candidate_tokens(expected))


def _location(row: sqlite3.Row) -> dict[str, Any]:
    location: dict[str, Any] = {"section": row["section"], "path": json.loads(row["path_json"])}
    if row["part"]:
        location["part"] = row["part"]
    if row["owner_id"]:
        location["ownerId"] = row["owner_id"]
    return location


def _available_summary(db: sqlite3.Connection, spec: TargetSpec, scope: str) -> list[tuple[str, str, str]]:
    rows = db.execute(
        "SELECT scope, candidate_text, chinese_text FROM documents WHERE lower(headword)=lower(?) "
        "ORDER BY scope, weight DESC, id LIMIT 8",
        (spec.headword,),
    ).fetchall()
    return [(row["scope"], row["candidate_text"][:50], row["chinese_text"][:90]) for row in rows if row["scope"] == scope][:5]


def _resolve_target(
    db: sqlite3.Connection,
    case: dict[str, Any],
    spec: TargetSpec,
) -> tuple[dict[str, Any], dict[str, Any]]:
    scope = spec.scope or (case["scopes"][0] if len(case["scopes"]) == 1 else "")
    if not scope or scope not in case["scopes"]:
        raise ValueError(f"{case['id']}: target {spec.headword!r} has no valid explicit scope")
    rows = _candidate_rows(db, spec.headword, scope, spec.anchor, spec.candidate)
    if spec.candidate:
        rows = [row for row in rows if _candidate_matches(row["candidate_text"], spec.candidate)]
    if not rows:
        raise ValueError(
            f"{case['id']}: no {scope} evidence for {spec.headword!r} anchor={spec.anchor!r} "
            f"candidate={spec.candidate!r}; available={_available_summary(db, spec, scope)}"
        )
    row = rows[0]
    if scope == "phrase" and not row["candidate_text"].strip():
        raise ValueError(f"{case['id']}: phrase target {spec.headword!r} has empty candidate_text")
    relevance = {"entryId": row["entry_id"], "headword": row["headword"], "grade": spec.grade}
    evidence = {
        **relevance,
        "evidence": {
            "scope": scope,
            "contains": spec.anchor,
            "location": _location(row),
        },
    }
    return relevance, evidence


def _resolve_forbidden(db: sqlite3.Connection, case: dict[str, Any], spec: ForbiddenSpec) -> dict[str, Any]:
    if spec.scope not in case["scopes"]:
        raise ValueError(f"{case['id']}: forbidden scope {spec.scope!r} is outside requested scopes")
    rows = _candidate_rows(db, spec.headword, spec.scope, spec.anchor, None)
    if not rows:
        probe = TargetSpec(spec.headword, 1, spec.anchor, spec.scope)
        raise ValueError(
            f"{case['id']}: forbidden {spec.headword!r} is not anchored; "
            f"available={_available_summary(db, probe, spec.scope)}"
        )
    row = rows[0]
    return {
        "entryId": row["entry_id"],
        "headword": row["headword"],
        "grade": 0,
        "evidence": {"scope": spec.scope, "contains": spec.anchor, "location": _location(row)},
    }


def _development_entry_ids(path: Path) -> set[str]:
    cases = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(cases, list):
        raise ValueError(f"development data is not an array: {path}")
    return {
        target["entryId"]
        for case in cases
        for target in case.get("relevance", [])
        if isinstance(target, dict) and isinstance(target.get("entryId"), str)
    }


def _verify_gap(db: sqlite3.Connection, case: dict[str, Any]) -> None:
    for headword in case["gap"]["missingHeadwords"]:
        scopes = {row[0] for row in db.execute("SELECT scope FROM documents WHERE lower(headword)=lower(?)", (headword,))}
        if case["gap"]["absence"] == "all-scopes" and scopes:
            raise ValueError(f"{case['id']}: all-scope gap headword is present: {headword!r} scopes={sorted(scopes)}")
        if case["gap"]["absence"] == "selected-scopes" and not scopes.isdisjoint(case["scopes"]):
            raise ValueError(f"{case['id']}: selected-scope gap headword is present: {headword!r} scopes={sorted(scopes)}")


def build(reverse_db: Path, development: Path) -> list[dict[str, Any]]:
    development_ids = _development_entry_ids(development)
    output: list[dict[str, Any]] = []
    errors: list[str] = []
    with _open_read_only(reverse_db) as db:
        for source in source_cases():
            case = dict(source)
            relevance: list[dict[str, Any]] = []
            evidence: list[dict[str, Any]] = []
            for spec in case.pop("targetSpecs"):
                try:
                    resolved, expectation = _resolve_target(db, case, spec)
                except ValueError as error:
                    errors.append(str(error))
                    continue
                if any(item["entryId"] == resolved["entryId"] for item in relevance):
                    errors.append(f"{case['id']}: duplicate entry target {resolved['entryId']} ({resolved['headword']})")
                    continue
                relevance.append(resolved)
                evidence.append(expectation)
            forbidden: list[dict[str, Any]] = []
            for spec in case.pop("forbiddenSpecs"):
                try:
                    forbidden.append(_resolve_forbidden(db, case, spec))
                except ValueError as error:
                    errors.append(str(error))
            if case["expectation"] == "gap":
                try:
                    _verify_gap(db, case)
                except ValueError as error:
                    errors.append(str(error))
            case["relevance"] = relevance
            case["evidenceExpectations"] = evidence
            case["forbidden"] = forbidden
            if any(target["grade"] >= 2 and target["entryId"] not in development_ids for target in relevance):
                case["tags"] = [*case["tags"], "novel-target"]
            output.append(case)
    if errors:
        raise ValueError("unresolved blind annotations:\n" + "\n".join(errors))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reverse-db", type=Path, default=DEFAULT_REVERSE_DB)
    parser.add_argument("--development", type=Path, default=DEFAULT_DEVELOPMENT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="compare generated bytes with the checked-in holdout")
    args = parser.parse_args()
    encoded = json.dumps(build(args.reverse_db, args.development), ensure_ascii=False, indent=2) + "\n"
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
