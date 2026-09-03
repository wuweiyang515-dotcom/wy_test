# wy_test

一个轻量的飞书（Lark）云文档命令行工具，让 Copilot 只凭一条飞书链接就能读取、修改和新建文档。

## 快速开始

```bash
feishu check                                  # 自检：只验证凭证与网络
feishu check https://xxx.feishu.cn/docx/AbC…  # 自检：再读一次文档标题，验证权限
feishu read https://xxx.feishu.cn/wiki/AbC…   # 读取正文（wiki 链接会自动解析到真实文档）
feishu append <链接> --text "一行内容"         # 追加段落
feishu update <链接> --block <block_id> --text "新内容"
feishu create --title "新文档" --folder <文件夹链接或 token> --text "初始内容"
```

不带参数运行 `feishu help` 可查看完整用法。

## 一次性配置（需要仓库管理员操作）

以下两步只能由仓库/租户管理员完成，缺一不可。

### 1. 开通网络白名单

Copilot 的沙箱默认屏蔽外网域名，飞书域名必须显式放行，否则所有请求都会 DNS 解析失败。

在仓库 **Settings → Copilot → Coding agent** 的防火墙设置里，把下列域名加入允许列表：

- `open.feishu.cn`（飞书 / 中国区）
- `open.larksuite.com`（Lark / 国际版，如需要）

参考：[Customizing or disabling the firewall for Copilot coding agent](https://docs.github.com/en/copilot/customizing-copilot/customizing-or-disabling-the-firewall-for-copilot-coding-agent)

### 2. 准备凭证

1. 在 [飞书开放平台](https://open.feishu.cn/app) 创建一个 **企业自建应用**。
2. 为应用开通云文档相关权限，并发布版本等待管理员审核：
   - `docx:document`（新版文档读写）
   - `docs:document:readonly`（旧版文档读取，可选）
   - `drive:drive`（云空间文件读写，新建文档需要）
   - `wiki:wiki:readonly`（知识库节点读取，处理 `/wiki/` 链接需要）
   - `sheets:spreadsheet:readonly` / `bitable:app:readonly`（如需读取表格、多维表格标题）
3. **把目标文档、文件夹或知识库共享给该应用**（在文档的「…」→「添加文档应用」中添加应用，或把应用加入知识库成员）。仅有 API 权限但没有文档授权时会返回 `permission denied`。
4. 在仓库 **Settings → Environments → `copilot`** 中添加环境 secrets：

   | 名称                 | 说明                                        |
   | -------------------- | ------------------------------------------- |
   | `FEISHU_APP_ID`      | 应用的 App ID                               |
   | `FEISHU_APP_SECRET`  | 应用的 App Secret                           |
   | `FEISHU_DOMAIN`      | 可选，Lark 国际版填 `https://open.larksuite.com` |

   凭证只以 secret 形式存在，**绝不写入代码**。

### 3. 验证

合入默认分支后，在 **Actions** 页手动运行 `Copilot Setup Steps` 工作流，确认工具链正常；再让 Copilot 执行一次
`feishu check <一篇测试文档链接>`，能打印出文档标题即代表白名单、权限与共享设置全部就绪。

## 工具链

`.github/workflows/copilot-setup-steps.yml` 会在每次 Copilot 会话开始前安装 Node.js 20 并把 `feishu`
命令链接到 PATH，做到开箱即用。

飞书官方并没有通用的「文档读写 CLI」，因此这里基于官方 OpenAPI 自行封装了一个薄壳。它只使用 Node.js 内置的
`fetch`，没有任何第三方运行时依赖。

## 目录结构

| 路径              | 说明                                                        |
| ----------------- | ----------------------------------------------------------- |
| `src/cli.js`      | 命令行入口与参数解析                                        |
| `src/url.js`      | 飞书链接解析：识别 docx / docs / sheets / base / wiki / 文件夹 |
| `src/client.js`   | OpenAPI 客户端：`tenant_access_token` 获取与缓存、错误处理   |
| `src/docs.js`     | 文档操作：wiki 解析、读取、追加、更新、新建                  |
| `test/`           | 链接解析的单元测试（不联网）                                |

## 开发

```bash
npm test
```
