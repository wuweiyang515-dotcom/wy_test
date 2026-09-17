#!/usr/bin/env python3
"""按飞书「点击分析 / 展现分析」模板输出 GSC 周对比报告。

模板结构（每个页签）
--------------------
    标题行：路径 GSC【点击量】周对比分析 —— 本期 X~Y  vs  对比期 A~B
    一、各路径分组总览
    二、点击量提升 TOP10（根目录 范围）
    三、点击量下降 TOP10（根目录 范围）
    四、关键词维度归因分解（点击提升/下降 TOP5 URL）
    五、关键词数据明细（TOP10 提升/下降URL，每个 URL 最多 15 条）

口径与飞书表一致
----------------
* 路径分组：`根目录` 为 `/eu-fr/` 下全部 URL（**包含** blogs 与 collections），
  `博客`、`合集` 为其子集，三者不是互斥关系。
* `URL数量` 取 `urls` 表中该前缀下的 URL 总数（含当期无流量的页面）。
* 展现 / 点击按天求和；URL 级数值先按 (url_id, data_date) 去重，避免被关键词行重复放大。
* 平均排名 = Σ(每日排名 × 每日展现) / Σ(每日展现)，只有展现 > 0 的天参与计算。
* 点击率 = 点击 / 展现（加权）。

第四节的归因分解
----------------
    总点击变化 = 新增词贡献 + 流失词贡献 + 存量词展现效应 + 存量词点击率/排名效应
               + 长尾/未列出关键词贡献
其中前四项由关键词明细算出，最后一项是 URL 级总量与关键词级合计的差额——
GSC 不下发匿名化查询，这部分点击无法归到具体词上。

凭证只从环境变量读取：DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD。
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import timedelta

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from gsc_week_compare import (
    connect,
    decompose,
    fetch_keyword_level,
    fetch_url_level,
    parse_date,
    resolve_domain_id,
    safe_div,
)

ROOT_GROUP = "根目录"
GROUPS = [
    (ROOT_GROUP, ""),
    ("博客", "blogs/"),
    ("合集", "collections/"),
]


# --------------------------------------------------------------------------- #
# 取数
# --------------------------------------------------------------------------- #
def count_urls(conn, domain_id, prefix):
    """`urls` 表中该前缀下的 URL 总数，与飞书表的「URL数量」口径一致。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) AS n FROM urls WHERE domain_id = %s AND url LIKE %s",
            (domain_id, f"{prefix}%"),
        )
        return int(cur.fetchone()["n"])


def build_rows(raw_rows):
    """把 URL 级原始行整理成带差值与分解的字典。"""
    rows = []
    for r in raw_rows:
        cur_impr = float(r["cur_impr"])
        prev_impr = float(r["prev_impr"])
        parts = decompose(prev_impr, float(r["prev_clicks"]), cur_impr, float(r["cur_clicks"]))
        rows.append(
            {
                "url_id": r["url_id"],
                "url": r["url"],
                "prev_impr": prev_impr,
                "cur_impr": cur_impr,
                "prev_clicks": float(r["prev_clicks"]),
                "cur_clicks": float(r["cur_clicks"]),
                "prev_ctr": parts["ctr_prev"],
                "cur_ctr": parts["ctr_cur"],
                "prev_rank": safe_div(float(r["prev_rank_w"]), prev_impr),
                "cur_rank": safe_div(float(r["cur_rank_w"]), cur_impr),
                "d_impr": parts["d_impr"],
                "d_clicks": parts["d_clicks"],
            }
        )
    return rows


def build_keyword_rows(raw_rows):
    rows = []
    for r in raw_rows:
        cur_impr = float(r["cur_impr"])
        prev_impr = float(r["prev_impr"])
        parts = decompose(prev_impr, float(r["prev_clicks"]), cur_impr, float(r["cur_clicks"]))
        rows.append(
            {
                "url_id": r["url_id"],
                "keyword": (r["keyword"] or "").strip(),
                "prev_impr": prev_impr,
                "cur_impr": cur_impr,
                "prev_clicks": float(r["prev_clicks"]),
                "cur_clicks": float(r["cur_clicks"]),
                "prev_ctr": parts["ctr_prev"],
                "cur_ctr": parts["ctr_cur"],
                "prev_rank": safe_div(float(r["prev_rank_w"]), prev_impr),
                "cur_rank": safe_div(float(r["cur_rank_w"]), cur_impr),
                "d_impr": parts["d_impr"],
                "d_clicks": parts["d_clicks"],
                "d_ctr": parts["d_ctr"],
                "impr_effect": parts["impr_effect"],
                # 交互项并入点击率/排名效应，保证四项相加可还原存量词的点击变化
                "ctr_effect": parts["ctr_effect"] + parts["interaction"],
            }
        )
    return rows


def attribute(url_row, keywords):
    """把某个 URL 的点击变化拆成五项。"""
    new_contrib = sum(k["cur_clicks"] for k in keywords if k["prev_impr"] == 0)
    lost_contrib = -sum(k["prev_clicks"] for k in keywords if k["cur_impr"] == 0)
    retained = [k for k in keywords if k["prev_impr"] > 0 and k["cur_impr"] > 0]
    impr_effect = sum(k["impr_effect"] for k in retained)
    ctr_effect = sum(k["ctr_effect"] for k in retained)
    explained = new_contrib + lost_contrib + impr_effect + ctr_effect
    return {
        "new": new_contrib,
        "lost": lost_contrib,
        "impr_effect": impr_effect,
        "ctr_effect": ctr_effect,
        "tail": url_row["d_clicks"] - explained,
    }


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #
TITLE_FONT = Font(bold=True, size=13)
SECTION_FONT = Font(bold=True, size=11)
HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
HEADER_FONT = Font(color="FFFFFF", bold=True)


class SheetWriter:
    """按「标题 / 小节 / 表头 / 数据行」逐行写入，贴合飞书表的排版。"""

    def __init__(self, workbook, title):
        self.ws = workbook.create_sheet(title)
        self.widths = defaultdict(int)

    def _track(self, values):
        for idx, value in enumerate(values, start=1):
            text = "" if value is None else str(value)
            # 中文按两个字符宽度估算
            width = sum(2 if ord(ch) > 0x2E80 else 1 for ch in text)
            self.widths[idx] = max(self.widths[idx], min(width + 2, 70))

    def title(self, text):
        self.ws.append([text])
        self.ws.cell(row=self.ws.max_row, column=1).font = TITLE_FONT
        self._track([text])

    def blank(self):
        self.ws.append([])

    def section(self, text):
        self.ws.append([text])
        self.ws.cell(row=self.ws.max_row, column=1).font = SECTION_FONT
        self._track([text])

    def header(self, values):
        self.ws.append(values)
        for cell in self.ws[self.ws.max_row]:
            if cell.value is not None:
                cell.fill = HEADER_FILL
                cell.font = HEADER_FONT
                cell.alignment = Alignment(vertical="center", wrap_text=True)
        self._track(values)

    def row(self, values):
        self.ws.append(values)
        self._track(values)

    def finish(self):
        for idx, width in self.widths.items():
            self.ws.column_dimensions[get_column_letter(idx)].width = max(10, width)


def r2(value):
    return round(float(value), 2)


def r4(value):
    return round(float(value), 4)


def write_analysis_sheet(wb, *, metric, rows, groups, url_counts, kw_by_url, periods, top_n, kw_top):
    """metric = 'click' 或 'impression'，两张表结构一致，只是主指标不同。"""
    is_click = metric == "click"
    label = "点击量" if is_click else "展现量"
    writer = SheetWriter(wb, "点击分析" if is_click else "展现分析")
    cur_start, cur_end, prev_start, prev_end = periods

    writer.title(
        f"路径 GSC【{label}】周对比分析 —— 本期 {cur_start}~{cur_end}  vs  对比期 {prev_start}~{prev_end}"
    )
    writer.blank()

    # ---- 一、各路径分组总览 ----
    writer.section("一、各路径分组总览")
    if is_click:
        writer.header(
            ["路径分组", "URL数量", "本周总点击", "上周总点击", "点击变化",
             "本周总展现", "上周总展现", "展现变化"]
        )
    else:
        writer.header(
            ["路径分组", "URL数量", "本周总展现", "上周总展现", "展现变化",
             "本周总点击", "上周总点击", "点击变化"]
        )
    for name, members in groups.items():
        cur_impr = sum(r["cur_impr"] for r in members)
        prev_impr = sum(r["prev_impr"] for r in members)
        cur_clicks = sum(r["cur_clicks"] for r in members)
        prev_clicks = sum(r["prev_clicks"] for r in members)
        click_block = [int(cur_clicks), int(prev_clicks), int(cur_clicks - prev_clicks)]
        impr_block = [int(cur_impr), int(prev_impr), int(cur_impr - prev_impr)]
        first, second = (click_block, impr_block) if is_click else (impr_block, click_block)
        writer.row([name, url_counts[name], *first, *second])
    writer.blank()

    # ---- 二 / 三、升降 TOP N ----
    key = (lambda r: r["d_clicks"]) if is_click else (lambda r: r["d_impr"])
    gainers = sorted(rows, key=key, reverse=True)[:top_n]
    losers = sorted(rows, key=key)[:top_n]

    if is_click:
        detail_header = ["URL", "点击变化", "本周点击", "上周点击", "展现变化",
                         "本周排名", "上周排名", "本周点击率", "上周点击率"]

        def detail_row(r):
            return [r["url"], int(r["d_clicks"]), int(r["cur_clicks"]), int(r["prev_clicks"]),
                    int(r["d_impr"]), r2(r["cur_rank"]), r2(r["prev_rank"]),
                    r4(r["cur_ctr"]), r4(r["prev_ctr"])]
    else:
        detail_header = ["URL", "展现变化", "本周展现", "上周展现",
                         "本周排名", "上周排名", "本周点击", "上周点击"]

        def detail_row(r):
            return [r["url"], int(r["d_impr"]), int(r["cur_impr"]), int(r["prev_impr"]),
                    r2(r["cur_rank"]), r2(r["prev_rank"]),
                    int(r["cur_clicks"]), int(r["prev_clicks"])]

    for section, bucket in ((f"二、{label}提升 TOP{top_n}（{ROOT_GROUP} 范围）", gainers),
                            (f"三、{label}下降 TOP{top_n}（{ROOT_GROUP} 范围）", losers)):
        writer.section(section)
        writer.header(detail_header)
        for r in bucket:
            writer.row(detail_row(r))
        writer.blank()

    if not is_click:
        writer.finish()
        return

    # ---- 四、关键词维度归因分解 ----
    writer.section(f"四、关键词维度归因分解（点击提升/下降 TOP{top_n // 2} URL）")
    writer.header(
        ["URL", "总点击变化", "新增关键词贡献", "流失关键词贡献", "存量词-展现量效应",
         "存量词-点击率/排名效应", "长尾/未逐条列出关键词贡献(GSC匿名化口径差异)"]
    )
    for r in gainers[: top_n // 2] + losers[: top_n // 2]:
        parts = attribute(r, kw_by_url.get(r["url_id"], []))
        writer.row(
            [r["url"], int(r["d_clicks"]), int(parts["new"]), int(parts["lost"]),
             round(parts["impr_effect"], 1), round(parts["ctr_effect"], 1), round(parts["tail"])]
        )
    writer.blank()

    # ---- 五、关键词数据明细 ----
    writer.section(
        f"五、关键词数据明细（TOP{top_n} 提升/下降URL，按点击变化排序，每个URL最多{kw_top}条，"
        "含点击率对比；每个URL行本身即为该组的表头行）"
    )
    for r in gainers + losers:
        writer.header(
            [r["url"], "关键词", "点击变化", "本周点击", "上周点击", "本周展现", "上周展现",
             "本周点击率", "上周点击率", "点击率变化", "本周排名", "上周排名"]
        )
        words = sorted(
            kw_by_url.get(r["url_id"], []),
            key=lambda k: (abs(k["d_clicks"]), abs(k["d_impr"])),
            reverse=True,
        )[:kw_top]
        for k in words:
            writer.row(
                ["", k["keyword"], int(k["d_clicks"]), int(k["cur_clicks"]), int(k["prev_clicks"]),
                 int(k["cur_impr"]), int(k["prev_impr"]), r4(k["cur_ctr"]), r4(k["prev_ctr"]),
                 r4(k["d_ctr"]), r2(k["cur_rank"]), r2(k["prev_rank"])]
            )
        writer.blank()
    writer.finish()


def write_notes_sheet(wb, periods, root_prefix, top_n, kw_top):
    cur_start, cur_end, prev_start, prev_end = periods
    writer = SheetWriter(wb, "口径说明")
    writer.header(["项目", "说明"])
    for item, text in [
        ("本期", f"{cur_start} ~ {cur_end}"),
        ("对比期", f"{prev_start} ~ {prev_end}（自动向前平移等长天数）"),
        ("根目录", f"{root_prefix} 下全部 URL，包含 blogs 与 collections"),
        ("博客 / 合集", "根目录的子集，与根目录不是互斥关系，因此三行不可相加"),
        ("URL数量", "urls 表中该前缀下的 URL 总数，包含当期无流量的页面"),
        ("展现 / 点击", "按天求和；URL 级数值先按 (url_id, data_date) 去重后再汇总"),
        ("平均排名", "Σ(每日排名 × 每日展现) / Σ(每日展现)，仅展现>0 的天参与；数值越小越好"),
        ("点击率", "点击 / 展现（加权），不是每日点击率的算术平均"),
        (
            "第四节分解",
            "总点击变化 = 新增词 + 流失词 + 存量词展现效应 + 存量词点击率/排名效应 + 长尾贡献；"
            "存量词展现效应 = Σ(Δ展现 × 上周点击率)，点击率/排名效应 = Σ(上周展现 × Δ点击率 + Δ展现 × Δ点击率)",
        ),
        (
            "长尾贡献",
            "URL 级点击变化与关键词级合计的差额。GSC 不下发匿名化查询，这部分点击无法归到具体关键词",
        ),
        ("榜单条数", f"升/降各 TOP{top_n}，第四节取各 TOP{top_n // 2}，每个 URL 最多展开 {kw_top} 个关键词"),
        ("关键词排序", "按点击变化绝对值降序，其次按展现变化绝对值降序"),
    ]:
        writer.row([item, text])
    writer.finish()


# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="按飞书「点击分析」模板输出 GSC 周对比报告")
    parser.add_argument("--domain", default="eufy.com", help="域名关键字，用于在 domains 表中定位")
    parser.add_argument("--domain-id", type=int, help="直接指定 domain_id，优先于 --domain")
    parser.add_argument("--root", default="https://www.eufy.com/eu-fr/", help="根目录前缀")
    parser.add_argument("--week-start", required=True, help="本期开始日期 YYYY-MM-DD")
    parser.add_argument("--week-end", required=True, help="本期结束日期 YYYY-MM-DD")
    parser.add_argument("--top", type=int, default=10, help="升/降榜各取多少条 URL")
    parser.add_argument("--kw-top", type=int, default=15, help="每个 URL 展开多少个关键词")
    parser.add_argument("--out", required=True, help="输出 Excel 路径")
    args = parser.parse_args()

    cur_start = parse_date(args.week_start)
    cur_end = parse_date(args.week_end)
    if cur_end < cur_start:
        sys.exit("--week-end 不能早于 --week-start")
    span = (cur_end - cur_start).days + 1
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=span - 1)
    periods = (cur_start, cur_end, prev_start, prev_end)

    root = args.root if args.root.endswith("/") else args.root + "/"

    conn = connect()
    try:
        domain_id = args.domain_id or resolve_domain_id(conn, args.domain)
        rows = build_rows(fetch_url_level(conn, domain_id, [root], prev_start, cur_start, cur_end))

        groups = {}
        url_counts = {}
        for name, suffix in GROUPS:
            prefix = root + suffix
            groups[name] = [r for r in rows if r["url"].startswith(prefix)]
            url_counts[name] = count_urls(conn, domain_id, prefix)

        focus = set()
        for key in (lambda r: r["d_clicks"], lambda r: r["d_impr"]):
            ordered = sorted(rows, key=key, reverse=True)
            focus.update(r["url_id"] for r in ordered[: args.top])
            focus.update(r["url_id"] for r in ordered[-args.top :])
        kw_rows = build_keyword_rows(
            fetch_keyword_level(conn, domain_id, sorted(focus), prev_start, cur_start, cur_end)
        )
    finally:
        conn.close()

    kw_by_url = defaultdict(list)
    for row in kw_rows:
        kw_by_url[row["url_id"]].append(row)

    wb = Workbook()
    wb.remove(wb.active)
    for metric in ("click", "impression"):
        write_analysis_sheet(
            wb,
            metric=metric,
            rows=rows,
            groups=groups,
            url_counts=url_counts,
            kw_by_url=kw_by_url,
            periods=periods,
            top_n=args.top,
            kw_top=args.kw_top,
        )
    write_notes_sheet(wb, periods, root, args.top, args.kw_top)
    wb.save(args.out)

    root_rows = groups[ROOT_GROUP]
    print(f"本期 {cur_start}~{cur_end} vs 对比期 {prev_start}~{prev_end}")
    for name in url_counts:
        members = groups[name]
        d_clicks = sum(r["cur_clicks"] - r["prev_clicks"] for r in members)
        d_impr = sum(r["cur_impr"] - r["prev_impr"] for r in members)
        print(f"  {name}: URL {url_counts[name]}，点击 {d_clicks:+.0f}，展现 {d_impr:+.0f}")
    print(f"有流量 URL {len(root_rows)} 个，关键词明细 {len(kw_rows)} 条")
    print(f"Excel 已输出：{args.out}")


if __name__ == "__main__":
    main()
