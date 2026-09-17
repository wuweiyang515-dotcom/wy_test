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
