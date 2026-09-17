# GSC 周对比分析脚本

`tools/gsc_week_compare.py` 从 `pmauto_system` 库读取 GSC 数据，对比指定 URL 路径下
「本周 vs 上周」的展现量、点击量、点击率、平均排名，输出升降榜与关键词级归因，
结果写入 Excel（多页签）并打印文字结论。

## 依赖

```bash
pip install pymysql openpyxl
```

## 使用

凭证只从环境变量读取，**不要写进代码或提交到仓库**：

```bash
export DB_HOST=... DB_PORT=3306 DB_DATABASE=pmauto_system DB_USERNAME=... DB_PASSWORD=...

python3 tools/gsc_week_compare.py \
  --domain-id 3 \
  --paths https://www.eufy.com/eu-fr/ https://www.eufy.com/eu-fr/blogs/ https://www.eufy.com/eu-fr/collections/ \
  --week-start 2026-08-15 --week-end 2026-08-21 \
  --top 20 --min-impr 100 --kw-top 15 \
  --out reports/report.xlsx --markdown reports/report.md
```

上周区间由本周区间自动向前平移等长天数。常用参数：

| 参数 | 说明 |
| --- | --- |
| `--domain-id` / `--domain` | 指定 domains 表中的域名（`--domain` 按关键字模糊匹配） |
| `--paths` | URL 前缀列表，按最长前缀归组，不重复计数 |
| `--top` | 升/降榜各取多少条 URL（默认 20） |
| `--min-impr` | 入榜门槛：两周展现量最大值（默认 100），用于过滤小样本噪声 |
| `--kw-top` | 每个入榜 URL 展开多少个关键词（默认 15） |

## 口径

* URL 级指标取 `url_gsc_traffic.url_*`。同一 `(url_id, data_date)` 的 URL 级数值会在
  每个关键词行上重复，因此先按 `(url_id, data_date)` 去重再按天求和。
* 关键词级指标取 `keyword_*`，只覆盖 GSC 下发的头部查询，合计小于 URL 总量，
  只用于解释变化原因，不用于统计总量。
* 点击率 = 点击 / 展现（加权）；平均排名 = Σ(排名 × 展现) / Σ(展现)，数值越小越好。
* 变化分解：`Δ点击 = Δ展现 × 上周CTR + 上周展现 × ΔCTR + Δ展现 × ΔCTR`，
  三项中绝对值最大的即为主因；点击率主因再结合 Δ平均排名区分「排名驱动」与
  「标题/摘要/SERP 形态或意图变化」。

## 输出页签

| 页签 | 内容 |
| --- | --- |
| `Summary` | 整体与分路径的两周对比及变化分解 |
| `URL_Gainers` / `URL_Losers` | 点击提升 / 下降最多的 URL 明细与主因 |
| `URL_Impr_Changes` | 按展现变化排序的 URL，捕捉「曝光变了但点击没跟上」的页面 |
| `KW_Gainers` / `KW_Losers` | 入榜 URL 的关键词级明细（新增词 / 流失词 / 留存词） |
| `Notes` | 口径与参数说明 |

---

# 飞书模板版：点击分析 / 展现分析

`tools/gsc_click_analysis.py` 按飞书表「点击分析」页签的排版输出报告，
生成 `点击分析`、`展现分析`、`口径说明` 三个页签。

```bash
python3 tools/gsc_click_analysis.py \
  --domain-id 3 \
  --root https://www.eufy.com/eu-fr/ \
  --week-start 2026-08-15 --week-end 2026-08-21 \
  --top 10 --kw-top 15 \
  --out reports/report.xlsx
```

页签结构与飞书表一致：

1. 各路径分组总览（根目录 / 博客 / 合集）
2. 点击量提升 TOP10（根目录 范围）
3. 点击量下降 TOP10（根目录 范围）
4. 关键词维度归因分解（点击提升/下降 TOP5 URL）
5. 关键词数据明细（每个 URL 最多 15 条）

## 与 `gsc_week_compare.py` 的分组差异

| | `gsc_click_analysis.py`（飞书模板） | `gsc_week_compare.py` |
| --- | --- | --- |
| 根目录 | `/eu-fr/` 下**全部** URL，含 blogs 与 collections | 排除 blogs 与 collections |
| 三行关系 | 博客、合集是根目录的子集，**不可相加** | 三组互斥，可相加 |
| URL数量 | `urls` 表中该前缀下的 URL 总数（含无流量页面） | 当期有展现的 URL 数 |

## 第四节的五项分解

```
总点击变化 = 新增词贡献 + 流失词贡献 + 存量词展现效应
           + 存量词点击率/排名效应 + 长尾贡献
```

* 新增词：上周无展现、本周有展现，贡献取本周点击。
* 流失词：上周有展现、本周无展现，贡献取上周点击的相反数。
* 存量词展现效应：`Σ(Δ展现 × 上周点击率)`。
* 存量词点击率/排名效应：`Σ(上周展现 × Δ点击率 + Δ展现 × Δ点击率)`。
* 长尾贡献：URL 级点击变化与关键词级合计的差额。GSC 不下发匿名化查询，
  这部分点击无法归到具体关键词上。
