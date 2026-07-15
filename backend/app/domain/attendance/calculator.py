from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta

from ...shared.calendar_utils import selectable_workdays

STATUS_OFFICE = "office"
STATUS_HOME = "home"
STATUS_LEAVE = "leave"
STRATEGY_RECOMMENDED = "recommended"
STRATEGY_ALGORITHMIC = "algorithmic"
STRATEGY_WEEKLY_BALANCED = "weekly-balanced"
STRATEGY_MON_TUE_WED = "prefer-mon-tue-wed"
STRATEGY_PREFER_TUE_THU = "prefer-tue-thu"
STRATEGY_WED_THU_FRI = "prefer-wed-thu-fri"
STRATEGY_MON_WED_FRI = "prefer-mon-wed-fri"
STRATEGY_CONSECUTIVE = "consecutive"
STRATEGY_SPREAD = "spread"
SMART_SCHEDULE_STRATEGIES = {
    STRATEGY_RECOMMENDED: "智能算法推荐",
    STRATEGY_MON_TUE_WED: "周一二三优先",
    STRATEGY_PREFER_TUE_THU: "周二三四优先",
    STRATEGY_WED_THU_FRI: "周三四五优先",
    STRATEGY_MON_WED_FRI: "周一三五分散",
}
SMART_SCHEDULE_INTERNAL_LABELS = {
    **SMART_SCHEDULE_STRATEGIES,
    STRATEGY_ALGORITHMIC: "智能算法推荐",
}
ACCEPTED_SMART_SCHEDULE_STRATEGIES = set(SMART_SCHEDULE_STRATEGIES) | {STRATEGY_WEEKLY_BALANCED, STRATEGY_CONSECUTIVE, STRATEGY_SPREAD}
STRATEGY_ALIASES = {
    STRATEGY_WEEKLY_BALANCED: STRATEGY_MON_WED_FRI,
    STRATEGY_CONSECUTIVE: STRATEGY_MON_TUE_WED,
    STRATEGY_SPREAD: STRATEGY_MON_WED_FRI,
}
WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
WEEKDAY_PRIOR_PROBABILITIES = {0: 0.58, 1: 0.5, 2: 0.56, 3: 0.5, 4: 0.54, 5: 0.25, 6: 0.25}
WEEKDAY_PRIOR_STRENGTH = 2.0


def smart_strategy_label(strategy: str) -> str:
    return SMART_SCHEDULE_INTERNAL_LABELS.get(strategy, SMART_SCHEDULE_STRATEGIES[STRATEGY_MON_WED_FRI])


def infer_weekday_pattern(manual_days: list[dict]) -> str:
    weekdays = [date.fromisoformat(item["date"]).weekday() for item in manual_days]
    patterns = {
        STRATEGY_MON_TUE_WED: {0, 1, 2},
        STRATEGY_PREFER_TUE_THU: {1, 2, 3},
        STRATEGY_WED_THU_FRI: {2, 3, 4},
        STRATEGY_MON_WED_FRI: {0, 2, 4},
    }
    # 按”历史星期偏好与候选模式的重合度“评分：如果分数相同，按上方声明顺序决胜。
    # 确保同一批历史数据每次都能得到稳定推荐。
    return max(patterns, key=lambda key: (sum(1 for weekday in weekdays if weekday in patterns[key]), -list(patterns).index(key)))


def build_weekday_profile(history: list[dict] | None) -> dict:
    """构建可解释的预测画像。

    `office` 是正样本，`home` 是负样本，`leave` 不代表办公偏好所以不参与训练。
    近期记录权重更高：每个星期再叠加一个很弱的先验，避免少样本导致预测极端化。
    """
    manual_items = [item for item in (history or []) if item.get("status") in {STATUS_OFFICE, STATUS_HOME}]
    office_samples = sum(1 for item in manual_items if item.get("status") == STATUS_OFFICE)
    office_weight = {weekday: 0.0 for weekday in range(7)}
    decision_weight = {weekday: 0.0 for weekday in range(7)}
    if not manual_items:
        return {
            "samples": 0,
            "officeSamples": 0,
            "effectiveSamples": 0.0,
            "weekdayScores": WEEKDAY_PRIOR_PROBABILITIES.copy(),
            "weekdayProbabilities": WEEKDAY_PRIOR_PROBABILITIES.copy(),
            "topWeekdays": [],
        }

    parsed_items = sorted((date.fromisoformat(item["date"]), item["status"]) for item in manual_items)
    latest = parsed_items[-1][0]
    for current, status in parsed_items:
        month_delta = (latest.year - current.year) * 12 + latest.month - current.month
        weight = 1 / (1 + month_delta * 0.45)
        weekday = current.weekday()
        decision_weight[weekday] += weight
        if status == STATUS_OFFICE:
            office_weight[weekday] += weight

    weekday_probabilities = {}
    for weekday in range(7):
        prior = WEEKDAY_PRIOR_PROBABILITIES[weekday] * WEEKDAY_PRIOR_STRENGTH
        weekday_probabilities[weekday] = (office_weight[weekday] + prior) / (decision_weight[weekday] + WEEKDAY_PRIOR_STRENGTH)
    top_weekdays = [weekday for weekday, score in sorted(weekday_probabilities.items(), key=lambda item: (-item[1], item[0])) if office_weight[weekday] > 0][:3]
    return {
        "samples": len(manual_items),
        "officeSamples": office_samples,
        "effectiveSamples": round(sum(decision_weight.values()), 4),
        "weekdayScores": weekday_probabilities,
        "weekdayProbabilities": weekday_probabilities,
        "topWeekdays": top_weekdays,
    }


def week_start(iso_date: str) -> str:
    current = date.fromisoformat(iso_date)
    return (current - timedelta(days=current.weekday())).isoformat()


def recommend_smart_strategy(history: list[dict] | None) -> dict:
    """根据用户自己手动选择的公司目标生成算法推荐说明。

    只统计手动标记为 "office" 的记录，因为 bulk/smart 生成的记录代表系统之前的安排，
    不能代表用户真实偏好。真正推荐时会考虑每个可选日期单独打分，而不是只能匹配内置选项。
    """
    manual_days = [item for item in (history or []) if item.get("status") == STATUS_OFFICE]
    base_strategy = STRATEGY_MON_WED_FRI if len(manual_days) < 2 else infer_weekday_pattern(manual_days)
    profile = build_weekday_profile(history)
    if len(manual_days) < 2:
        return {
            "strategy": STRATEGY_ALGORITHMIC,
            "label": smart_strategy_label(STRATEGY_ALGORITHMIC),
            "baseStrategy": base_strategy,
            "baseStrategyLabel": SMART_SCHEDULE_STRATEGIES[base_strategy],
            "confidence": "low",
            "reason": "手动公司打卡样本较少，将优先生成分散、稳妥的公司日安排。",
            "samples": len(manual_days),
            "topWeekdays": [WEEKDAY_NAMES[weekday] for weekday in profile["topWeekdays"]],
        }

    top_weekdays = [WEEKDAY_NAMES[weekday] for weekday in profile["topWeekdays"]]
    top_weekday_text = "、".join(str(value) for value in top_weekdays)
    reason = f"将根据你的历史偏好（{top_weekday_text}较常见）和每周达标要求逐日打分生成。"

    return {
        "strategy": STRATEGY_ALGORITHMIC,
        "label": smart_strategy_label(STRATEGY_ALGORITHMIC),
        "baseStrategy": base_strategy,
        "baseStrategyLabel": SMART_SCHEDULE_STRATEGIES[base_strategy],
        "confidence": "high" if len(manual_days) >= 6 else "medium",
        "reason": reason,
        "samples": len(manual_days),
        "topWeekdays": top_weekdays,
    }


def order_by_weekday_preference(dates: list[str], strategy: str) -> list[str]:
    """按照所选星期组合对候选工作日排序。"""
    preferences = {
        STRATEGY_MON_TUE_WED: {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6},
        STRATEGY_PREFER_TUE_THU: {1: 0, 2: 1, 3: 2, 0: 3, 4: 4, 5: 5, 6: 6},
        STRATEGY_WED_THU_FRI: {2: 0, 3: 1, 4: 2, 1: 3, 0: 4, 5: 5, 6: 6},
        STRATEGY_MON_WED_FRI: {0: 0, 2: 1, 4: 2, 1: 3, 3: 4, 5: 5, 6: 6},
    }
    preference = preferences.get(strategy, preferences[STRATEGY_MON_WED_FRI])
    return sorted(dates, key=lambda value: (preference[date.fromisoformat(value).weekday()], value))


def select_office_dates(dates: list[str], needed: int, strategy: str) -> set[str]:
    """为某个层级挑选需要设为公司打卡的日期。"""
    return set(order_by_weekday_preference(dates, strategy)[:needed])


def score_algorithmic_date(iso_date: str, profile: dict, existing_office_dates: set[str], selected_dates: set[str]) -> tuple[float, list[str]]:
    current = date.fromisoformat(iso_date)
    weekday = current.weekday()
    reasons = []
    probability = profile.get("weekdayProbabilities", profile["weekdayScores"]).get(weekday, WEEKDAY_PRIOR_PROBABILITIES[weekday])
    score = probability * 100
    if profile["samples"]:
        if probability >= 0.68:
            reasons.append(f"预测{WEEKDAY_NAMES[weekday]}更适合公司打卡")
        elif probability <= 0.42:
            reasons.append(f"历史上{WEEKDAY_NAMES[weekday]}较少选择公司打卡")
    else:
        reasons.append("历史样本较少，优先选择较分散的工作日")

    anchors = {date.fromisoformat(value) for value in existing_office_dates | selected_dates}
    if anchors:
        nearest_gap = min(abs(current - anchor.days) for anchor in anchors)
        score += min(nearest_gap, 3) * 4
        if nearest_gap >= 2:
            reasons.append("与本周已有公司日保持间隔")
        elif nearest_gap == 1:
            score -= 8
    else:
        score += max(0, 2 - abs(weekday - 2)) * 1.5

    reasons.append("本周仍需补足公司打卡")
    return round(score, 4), reasons


def select_algorithmic_office_dates(dates: list[str], needed: int, history: list[dict] | None, existing_office_dates: set[str]) -> tuple[set[str], list[dict]]:
    """基于日期评分选择公司日，而不是把用户偏好压缩成固定日期组合。"""
    profile = build_weekday_profile(history)
    remaining = set(dates)
    selected: set[str] = set()
    details = []
    while remaining and len(selected) < needed:
        scored = []
        for iso_date in remaining:
            score, reasons = score_algorithmic_date(iso_date, profile, existing_office_dates, selected)
            scored.append((score, iso_date, reasons))
        score, iso_date, reasons = max(scored, key=lambda item: (item[0], -date.fromisoformat(item[1]).toordinal()))
        selected.add(iso_date)
        remaining.remove(iso_date)
        details.append({"date": iso_date, "status": STATUS_OFFICE, "score": score, "reasons": reasons})
    return selected, sorted(details, key=lambda item: item["date"])


def calculate_attendance_summary(
        month: str,
        selections: dict[str, str],
        holidays: set[str],
        workday_overrides: set[str] | None,
        target_rate_percent: int | float,
        today: str | None = None,
) -> dict:
    """计算每日请假或缺勤的月度出勤汇总。

    请假在出勤计算中按休息日处理：既不进入分母，也不进入分子。

    返回两种出勤率：
    - 项目 "attendanceRate": 整月假期，用于月度达标状态判断。
    - 项目 "today.attendanceRate": 同一公式，但只计算截至 "today" 的日期，
    用于查看当前进度，避免未来未达标日期拉低进度指标。
    """
    # selectable_workdays = 是分母候选日期的唯一来源，普通工作日 - 节假日 + 周末补班。
    working_dates = selectable_workdays(month, holidays, workday_overrides)

    # 整月分母，公司/居家/未选择都计入，请假会被移除，因为业务规则把请假视为休息日。
    leave_days = sum(1 for iso_date in working_dates if selections.get(iso_date) == STATUS_LEAVE)
    denominator_dates = [iso_date for iso_date in working_dates if selections.get(iso_date) != STATUS_LEAVE]
    denominator = len(denominator_dates)
    office_days = sum(1 for iso_date in denominator_dates if selections.get(iso_date) == STATUS_OFFICE)
    home_days = sum(1 for iso_date in denominator_dates if selections.get(iso_date) == STATUS_HOME)
    unselected_days = denominator - office_days - home_days
    target_rate = max(0, float(target_rate_percent or 0)) / 100
    # 最低公司打卡天数给到上取整，与页面规则说明一致，避免出现小数天数要求。
    required_office_days = math.ceil(denominator * target_rate)
    attendance_rate = 0 if denominator == 0 else office_days / denominator

    # 截至今日指标复用完全相同的分子/分母规则，但候选日期限制为 <= today。
    # 因此未来未选择的工作日不会拉低当前进度指标。
    today_cutoff = today or date.today().isoformat()  # 拼写错误
    to_today_working_dates = [iso_date for iso_date in working_dates if iso_date <= today_cutoff]
    to_today_leave_days = sum(1 for iso_date in to_today_working_dates if selections.get(iso_date) == STATUS_LEAVE)
    to_today_denominator_dates = [iso_date for iso_date in to_today_working_dates if selections.get(iso_date) != STATUS_LEAVE]
    to_today_denominator = len(to_today_denominator_dates)
    to_today_office_days = sum(1 for iso_date in to_today_denominator_dates if selections.get(iso_date) == STATUS_OFFICE)
    to_today_home_days = sum(1 for iso_date in to_today_denominator_dates if selections.get(iso_date) == STATUS_HOME)
    to_today_unselected_days = to_today_denominator - to_today_office_days - to_today_home_days
    to_today_required_office_days = math.ceil(to_today_denominator * target_rate)
    to_today_attendance_rate = 0 if to_today_denominator == 0 else to_today_office_days / to_today_denominator

    return {
        "denominator": denominator,
        "requiredOfficeDays": required_office_days,
        "officeDays": office_days,
        "homeDays": home_days,
        "leaveDays": leave_days,
        "unselectedDays": unselected_days,
        "attendanceRate": attendance_rate,
        "remainingDays": max(0, required_office_days - office_days),
        "passed": office_days >= required_office_days,
        "toToday": {
            "denominator": to_today_denominator,
            "requiredOfficeDays": to_today_required_office_days,
            "officeDays": to_today_office_days,
            "homeDays": to_today_home_days,
            "leaveDays": to_today_leave_days,
            "unselectedDays": to_today_unselected_days,
            "attendanceRate": to_today_attendance_rate,
            "remainingDays": max(0, to_today_required_office_days - to_today_office_days),
            "passed": to_today_office_days >= to_today_required_office_days,
        },
    }


def build_smart_schedule(
        month: str,
        selections: dict[str, str],
        holidays: set[str],
        workday_overrides: set[str] | None,
        target_rate_percent: int | float,
        protected_dates: set[str] | None = None,
        strategy: str = STRATEGY_WEEKLY_BALANCED,
        history: list[dict] | None = None,
        adjustable_dates: set[str] | None = None,
) -> dict:
    """按周期规划公司/居家日期，并保持受保护的手动日期不变。

    排班器会尽量让月份内出现的每个周一到周日周期都达到目标公司打卡比例。
    因为每个周期独立向上取整，最终公司打卡天数可能略高于月度最低要求。

    adjustable_dates 是 UI/API 选择的可调整范围。默认只包含明天及之后；
    当用户勾选“包含过去日期”时，它包含整个月。范围外日期仍会作为既定事实参与
    每周计算，但排班器不会改变它们。
"""
    recommendation = recommend_smart_strategy(history)
    # 排班前先解析策略列表。用 API 调用方可修改传入历史策略名；当前 UI 只暴露明确的
    # 星期组合，但保留列表可以避免破坏已有调用。
    requested_strategy = strategy if strategy in ACCEPTED_SMART_SCHEDULE_STRATEGIES else STRATEGY_MON_WED_FRI
    resolved_strategy = STRATEGY_ALGORITHMIC if requested_strategy == STRATEGY_RECOMMENDED else STRATEGY_ALIASES.get(requested_strategy, requested_strategy)
    target_rate = max(0, float(target_rate_percent or 0)) / 100
    protected = protected_dates or set()
    adjustable = adjustable_dates
    working_dates = selectable_workdays(month, holidays, workday_overrides)
    groups: dict[str, list[str]] = defaultdict(list)
    for iso_date in working_dates:
        groups[week_start(iso_date)].append(iso_date)

    planned: dict[str, str] = {}
    weekly_plan = []
    recommended_dates = []

    for start in sorted(groups):
        dates = sorted(groups[start])
        # 每周分日按周月度汇总的请假排班规则。这也是通用上取整可能比严格月度最低值
        # 需要更多公司打卡天数的原因。
        denominator_dates = [iso_date for iso_date in dates if selections.get(iso_date) != STATUS_LEAVE]

        # 可排日期必须同时满足“在用户选择的范围内”且“不是手动保护日期”。手动选择固定不动。
        # smart/bulk 生成的选择可以按日期按排班规则。
        schedulable_dates = [iso_date for iso_date in denominator_dates if iso_date not in protected and (adjustable is None or iso_date in adjustable)]
        required = math.ceil(len(denominator_dates) * target_rate)

        # 不能被修改的日期仍然计入本周当前公司打卡数，排班规则需要补足剩余缺口。
        fixed_office_days = sum(1 for iso_date in denominator_dates if iso_date not in schedulable_dates and selections.get(iso_date) == STATUS_OFFICE)  # 语法错误
        needed_office_days = max(0, required - fixed_office_days)
        if resolved_strategy == STRATEGY_ALGORITHMIC:
            fixed_office_dates = {iso_date for iso_date in denominator_dates if iso_date not in schedulable_dates and selections.get(iso_date) == STATUS_OFFICE}
            office_dates, office_details = select_algorithmic_office_dates(schedulable_dates, needed_office_days, history, fixed_office_dates)
            recommended_dates.extend(office_details)
        else:
            office_dates = select_office_dates(schedulable_dates, needed_office_days, resolved_strategy)
        for iso_date in schedulable_dates:
            planned[iso_date] = STATUS_OFFICE if iso_date in office_dates else STATUS_HOME  # STATUS_NONE 未定义，可能是 STATUS_HOME 或留空
        weekly_plan.append(
            {
                "weekStart": start,
                "denominator": len(denominator_dates),
                "officeDays": fixed_office_days + len(office_dates),
                "requiredOfficeDays": required,
                "officeDates": sorted(office_dates),
                "homeDates": [iso_date for iso_date in schedulable_dates if iso_date not in office_dates],
                "achievable": fixed_office_days + len(office_dates) >= required,
            }
        )

    return {
        "plannedSelections": planned,
        "weeklyPlan": weekly_plan,
        "strategy": resolved_strategy,
        "strategyLabel": smart_strategy_label(resolved_strategy),
        "requestedStrategy": requested_strategy,
        "recommendation": recommendation,
        "recommendedDates": recommended_dates,
    }
