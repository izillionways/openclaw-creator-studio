# OpenClaw Creator Studio

A general-purpose OpenClaw plugin for evidence-backed articles, independent editorial review, version-bound human approval and portable exports.

面向任意主题、语言和发布平台的原生插件。获准的 Agent 负责研究与写作，插件保存版本并执行审核、人工审批和导出规则。微信公众号可以作为使用场景，系统不绑定公众号、钉钉、模型供应商或特定 Agent。

## 首版范围

- 研究、图文创作、内容审核三个配套 Skill，复用宿主已有的搜索、Browser、模型和消息渠道。
- 结构化稿件、来源与论据关联、正文配图、主题去重、定时运行幂等键。
- 本地规则检查 + 独立子 Agent 会话审核；人工审批绑定文章 ID、版本和内容 SHA-256。
- Markdown、HTML、来源元数据和本地图片导出，供人手动导入发布平台。
- 可选的认证预览和固定收件人通知，默认关闭。

不包含自动发表、公众号 API 写入、图片生成服务、搜索服务或公网托管。没有可信候选时应返回原因，不能为了日更编造文章。独立审核读取稿件和所附证据文本，不会重新访问来源，也不会检查图片像素；它不能证明作者实际操作过工具。

## 环境与安装

当前验证环境：OpenClaw **2026.10.10**、Node.js **24.22.2**、macOS arm64。使用该版本的原生插件工具上下文 v2、SQLite 和子 Agent 会话接口；更早的 OpenClaw 不在兼容范围内。Node 范围为 `>=24.16.0 <25 || >=26.1.0`；其他系统和版本尚未实机验证。运行时没有第三方 npm 依赖。

审核代码后安装固定版本：

```sh
openclaw plugins install git:github.com/izillionways/openclaw-creator-studio@v0.2.0 --no-enable
```

也可以下载 GitHub Release 中的安装包后执行：

```sh
openclaw plugins install npm-pack:./openclaw-creator-studio-0.2.0.tgz --no-enable
```

这两个命令会安装到执行者的 OpenClaw 环境。非交互安装新来源时，OpenClaw 可能要求 `--force`；应先检查代码和来源。发布在 GitHub，未发布到 npm 或 ClawHub。

插件 ID 是 `creator-studio`，npm 包名是 `openclaw-creator-studio`。安装后合并下方配置，再按宿主的插件管理流程启用：

```sh
openclaw plugins enable creator-studio
openclaw plugins inspect creator-studio --runtime --json
openclaw skills list --agent writer --json
```

若设置了 `plugins.allow`，保留原有条目并包含 `creator-studio`。官方安装命令会处理相应允许列表。CLI inspect 证明该 CLI 进程能加载插件；实际 Gateway 的工具、原生命令与渠道仍需在自己的环境验收。

## 最小配置

将以下片段**合并**到宿主配置，不要替换现有 Agent、工具或渠道配置。示例 `writer` 必须是已有 Agent；审批人的 channel、accountId、senderId 应取自宿主可信的入站消息元数据，不能让模型提供。

```json
{
  "plugins": {
    "entries": {
      "creator-studio": {
        "enabled": true,
        "config": {
          "allowedAgents": ["writer"],
          "enableReview": false,
          "timeZone": "Asia/Shanghai",
          "approvers": [
            {
              "agentId": "writer",
              "channel": "YOUR_CHANNEL_ID",
              "accountId": "YOUR_CHANNEL_ACCOUNT_ID",
              "senderId": "YOUR_HUMAN_SENDER_ID"
            }
          ]
        }
      }
    }
  },
  "agents": {
    "entries": {
      "writer": {
        "tools": {
          "alsoAllow": ["creator-studio"]
        }
      }
    }
  }
}
```

默认没有获准 Agent、没有审批人，模型审核、通知和预览均关闭。原生工具策略与插件的 `allowedAgents` 同时生效；后者不会授予搜索、文件写入、Browser 或其他能力。每篇文章由创建它的 Agent 所有，其他 Agent 不能通过这些工具读写它；多 Agent 可分别使用自己的稿件。

默认数据位置为宿主 state 目录下的 `creator-studio/`，图片导入范围为宿主 state 下的 `media/`。可设置绝对路径 `dataDir`、`assetRoots`，但不要把数据目录放在源码仓库或 Agent 工作区内。目录必须为私有真实目录（0700）；数据库及输出文件为 0600。导入仅支持每张不超过 8 MiB 的 PNG/JPEG/WebP，最多 12 张，拒绝允许范围之外的路径和符号链接逃逸。

所有配置字段见 [openclaw.plugin.json](openclaw.plugin.json)。主要默认限制：每 Agent 每天 1 篇新稿、4 次模型审核，每版本最多 2 次审核；正文为 600–30000 个非空白 Unicode 字符，至少一个主来源和一张正文配图。字数不含代码、参考资料，封面不算正文图。可按语言、平台调整长度，例如中文公众号设置 `minBodyChars: 1500`、`maxBodyChars: 2500`。

## 启用独立审核与费用

只有运营者明确同意模型用量后，才设置 `enableReview: true`。规则检查通过后，插件使用 `api.runtime.subagent.run` 创建全新的 `agent:<agentId>:subagent:creator-review-<UUID>` 会话，交入指定文章的 ID、版本、哈希、正文和证据。它不 fork 或继承写作会话历史，复用写作 Agent 已配置的默认模型与凭据，无需另建常驻审核 Agent，也不申请覆盖模型的权限。

子 Agent 使用 `promptMode: minimal`、`lightContext: true`、`disableTools: true` 和 `deliver: false`。它只返回结构化审核意见，不能搜索、改稿、批准、发表或发消息；仍受宿主系统提示、路由和模型回退等策略约束。主流程负责按意见修订新版本，再重新审核。缺少证据会被指出，不会由审核子 Agent 自动补齐。

需要已运行的 Gateway 和绑定插件身份的原生 `run`、`waitForRun`、`getSessionMessages`、`deleteSession` 接口。接口缺失时明确失败，不回退到作者自审或普通 completion。宿主模型必须配置明确的、支持无工具子 Agent 的 **model-scoped** `agentRuntime.id`。例如在已经配置好供应商和模型的环境中：

```json
{
  "agents": {
    "entries": {
      "writer": {
        "model": "YOUR_PROVIDER/YOUR_MODEL",
        "models": {
          "YOUR_PROVIDER/YOUR_MODEL": {
            "agentRuntime": { "id": "codex" }
          }
        }
      }
    }
  }
}
```

默认允许 `codex`、`claude-cli` runtime owner。不要把 `agentRuntime` 写在 Agent 顶层，也不要使用 `auto`：插件会在调用前拒绝不明确的路由，并核对子 Agent 的会话与接收回执中的 harness。其他 runtime 需由运营者验证其无工具契约后再加入 `reviewRuntimeOwners`。上述配置格式与旧版一致；本版本没有新增必填配置。

插件等待明确成功的运行结果，再从该会话读取完整 assistant 结论并校验 JSON、问题等级和来源引用。`pending` 或单次等待超时不代表完成；错误、截断、取消、版本过期和人工拒绝都不能变成通过。新审核记录包含 `mode: subagent`、`runId`、`sessionKey`，与稿件版本一起保存。

成功和失败均请求原生会话删除；原生删除会停止并排空该会话的活动任务。插件等待清理成功后才接受结果，停止插件时也会等待进行中的审核清理。Gateway 不可用或清理失败时不记录通过；运营者应检查宿主中 `creator-review-` 会话后再重试。清理和运行记录的实际保留仍按宿主规则处理，不承诺清除日志或所有历史副本。进程被强制杀死时插件无法执行清理，也需由宿主或运营者处理遗留会话。

规则检查失败时不调用模型。已发起但失败、取消或过期的请求仍计入审核次数，避免自动重试失控。默认 90 秒后取消审核并请求会话清理，清理本身可能额外耗时。子 Agent 接口不提供本插件可设置的 token 硬上限；**次数、超时及返回文本长度检查都不是金额硬上限**。用量仅记录宿主返回的有效数字，缺失不代表免费。费用取决于你的供应商和订阅，插件没有固定模型价格，也不增加独立订阅费。写作、搜索、Browser、图片生成、消息渠道和外网代理的用量由各宿主服务单独计费。插件不代为启用这些服务。

从 0.1.x 升级时，已有审核、批准和导出记录保持原样，不会被标记成子 Agent 审核，也不会因此自动产生模型费用；新建或修订版本后的审核使用上述子 Agent 流程。

## 工具与稿件流程

| 工具 | 用途 |
| --- | --- |
| `creator_article` | `create`、`revise`、`get`、`list`；修订必须提交当前版本 |
| `creator_review` | 规则检查后启动独立子 Agent，审核指定文章和当前版本 |
| `creator_submit` | 返回预览地址；仅在启用固定渠道后发送通知 |
| `creator_export` | 仅导出人工批准的当前版本 |

三个 Skill 分别是 `creator-topic-research`、`creator-article-creator`、`creator-editorial-review`。正常使用时向获准 Agent 描述主题、读者、语言、平台、长度与费用权限即可。研究使用已有工具或用户资料，图片由宿主已有能力或用户文件提供。

稿件使用结构化文档，字段和完整 schema 见 [src/tools.js](src/tools.js)：

- `title`、`summary`、`language`、可选的 `platform`。
- `blocks`：`heading`、`paragraph`、`list`、`code`、`image`。文字按纯文本保存，不能嵌入 HTML；图片块通过 `assetId` 引用图片。
- `sources`：唯一 `id`、真实公共 `url`、`title`、实际审阅资料的时间 `checkedAt`、`kind`（primary/secondary）和短证据 `excerpt`。在 excerpt 中注明读到的是原文、搜索摘要还是用户提供的资料，以及重要的获取限制；checkedAt 不是网页发布时间，也不证明该 URL 已被独立联网访问。
- `claims`：重要论断 `text` 及对应 `sourceIds`。保存引用关系不等于已证明论断真实，审核人仍需检查。
- `assets`：唯一 `id`、允许目录中的绝对 `path`、`alt`、`kind`（screenshot/illustration）、可选 `role`（body/cover）。截图另需已有 `sourceId` 和实际 `capturedAt`；示意图会被明确标注。

创建时传稳定的 `topicKey`；同一 Agent 不能重复创建这个选题。定时任务另传稳定 `runKey`，例如任务名与日期的组合。同键同初稿返回已有文章，不同内容会被拒绝并提示恢复已有文章，不能以重试为由新增稿件。修订重新提交完整文档，图片仍使用允许目录内的导入路径。

状态依次为 `draft` → `pending_human_review` → `approved_for_manual_publish` → `manually_published`。检查失败进入 `qa_failed`；人可拒绝或要求修改。修订生成新版本并使旧批准失效；正文、标题和图片变化都参与内容哈希。审核失败、取消、版本变化或人工拒绝不会被当成通过。

## 资料获取与可选集成

**News Aggregator、Agent-Reach 和 Exa 均不是插件的运行时依赖。** 没有安装它们不会导致插件加载失败。研究 Skill 根据当前 Agent 实际可见、获准且可用的工具选择路径；仅在其他客户端中配置的工具，不代表 OpenClaw 的这个 Agent 也能调用。

| 使用者环境 | 研究方式 |
| --- | --- |
| 有搜索、原文读取或适合该主题的平台工具 | 复用已有工具，尊重用户指定的来源和服务 |
| 没有合适的联网工具，或用户要求只使用所给资料 | 基于用户资料研究，并在来源记录及必要的正文中说明未独立联网核验 |
| 没有可用工具，也没有充分资料 | 停止研究并说明缺少的能力或证据，不创建凑数稿件 |

已有原始链接时可直接读取，不必先搜索；一个工具已返回足够原文时也不必重复抓取。工具缺失不触发自动安装、登录、密钥配置或付费调用。检索失败时保留已经取得的证据，说明限制，遵守工具的访问和重试规则；不静默替换用户明确要求的服务。

没有联网工具不等于来源要求被取消：现有结构化稿件仍要求真实公共来源链接，审核还要求至少一个主来源。提供的私人附件若没有真实公共参考链接，只能先形成明确标注的未核验文字初稿，不能编造 URL 或来源类型来进入审批和导出。具备合格来源记录也不保证独立审核会通过。

一种**可选组合**是：[News Aggregator](https://clawhub.ai/cclank/skills/news-aggregator-skill) 收集热榜候选 → 按编辑目标筛选、去重 → 用当前可用的搜索和平台工具研究 → 阅读原始资料 → 创作和审核。只有当前 Agent 能调用相应工具时，才使用这个组合：

- 热榜用于发现线索，先限制来源和候选数量，再深入研究选中的题目；不默认深抓所有条目。保留真实的热度、排名、时间标签和观察时间，不把“Today”等模糊标签当作精确发布时间，也不跨榜单直接比较不同单位的分数。
- 如果宿主已经暴露 `web_search_exa`、`web_fetch_exa`，可直接搜索和读取，不必经过 Agent-Reach 的 CLI。Exa 是可选的网页搜索路径，不是唯一研究渠道。
- Agent-Reach 按需补充平台内容、讨论或字幕，具体能力以所装版本和真实结果为准，不要求每篇都调用。其他搜索、平台工具或用户资料同样可以完成研究。
- 用户的主题、语言、时间范围和“没有可信候选就停止”等编辑要求优先于外部 Skill 的简报格式、最低条数或补旧新闻规则。安装和使用外部 Skill 前应核对其版本、依赖与权限；不随 Creator Studio 捆绑安装。

搜索服务的 Key 继续由宿主已有的安全配置管理，Creator Studio 不保存或代为配置它，也不授予额外额度。任务说明可以指定来源、候选数、搜索次数和费用权限；这些研究限额由 Skill 执行，**不是插件程序强制的工具调用或金额上限**。

这里实现的是 Skill 编排，没有新增程序层面的自动工具发现、服务切换或研究执行器。四个原生工具继续处理稿件、独立审核、提交和导出，人工批准仍绑定具体版本。

## 人工审批与发布

在已配置审批人且支持原生插件命令的渠道中，由真人发送：

```text
/creator status ARTICLE_ID
/creator status ARTICLE_ID VERSION
/creator approve ARTICLE_ID VERSION
/creator reject ARTICLE_ID VERSION 原因
/creator revise ARTICLE_ID VERSION 必须修改的内容
/creator published ARTICLE_ID VERSION
```

`ARTICLE_ID` 使用工具返回的 `cs-...` 值。除查询状态外必须指定版本；命令不能只批准“最新一篇”。只有主机认证且匹配审批人 channel/account/sender 的消息可以更改人工状态；工具参数不提供批准入口。被拒绝的文章必须先由人请求修订才能继续。

批准后让 Agent 调用 `creator_export`，返回导出目录，含 `article.html`、`article.md`、`article.json` 和 `assets/`。已有导出若被手工改动会保留并报冲突；不要覆盖它再声称是原批准稿。将内容与图片手动导入公众号或其他平台，检查排版并人工发表，之后才发送 `published` 确认。平台可能过滤 HTML、要求重新上传图片或使用不同粘贴规则；预览里的私有图片地址不能直接当作公众号图片地址。

版本哈希用于发现内容变化，不是数字签名。本插件和其他 OpenClaw 插件共享宿主权限；有任意 shell 或数据库写入权限的 Agent/用户可以绕过应用层约束。对不可信 Agent 应限制原始文件、shell 和宿主配置权限，不要把本地数据库当作对抗同机管理员的安全边界。

## 可选的手机预览与通知

预览只监听 `127.0.0.1`，页面和每张图片都要求 HTTP Basic 认证，页面不执行脚本，不提供批准按钮。口令从 Gateway 进程环境读取，至少 24 字符；在系统密钥/服务环境中设置 `CREATOR_STUDIO_PREVIEW_PASSWORD`，不要写进配置文件、仓库、URL 或聊天记录。仅在 Codex 终端设置变量不代表现有 Gateway 能读取它。

以下片段合并到插件的 `config`：

```json
{
  "preview": {
    "enabled": true,
    "port": 18890,
    "username": "reviewer",
    "passwordEnv": "CREATOR_STUDIO_PREVIEW_PASSWORD",
    "publicBaseUrl": "https://YOUR_PRIVATE_PREVIEW_DOMAIN"
  },
  "notification": {
    "enabled": true,
    "channel": "YOUR_CHANNEL_ID",
    "accountId": "YOUR_CHANNEL_ACCOUNT_ID",
    "to": "YOUR_FIXED_RECIPIENT"
  }
}
```

`publicBaseUrl` 必须替换为真实 HTTPS 域名的 origin，不含路径、查询参数或凭据。插件不会创建这个域名或代理。外网访问需由你部署 HTTPS 反向代理/私有隧道到 loopback 端口，保留 Authorization 头并关闭缓存和访问日志中的敏感信息；Basic 凭据不能通过公网明文 HTTP 传输。私有网络方案也可使用，但域名仍需 HTTPS。公开 URL 本身不授予读取权限。

通知只调用已安装渠道的原生 outbound 适配器，收件人固定在运营者配置中，Agent 不能重定向。钉钉可作为其中一种渠道，但具体插件须提供兼容的 outbound 和可信原生命令元数据。返回正常回执后才记录为 `sent`；超时、进程中断或缺回执会成为 `unknown`，重启后也不会自动重发。遇到 unknown，应人工核对目标会话和文章版本；首版不提供强制重发入口。

不开预览时，`creator_submit` 仍可返回稿件标识和 notification=disabled，不能生成手机可访问的链接。若只在本机检查页面，可启用预览而不设置外部地址；通知需同时具备外部 HTTPS 地址和明确渠道路由。

## 可选的原生定时任务

插件不创建定时任务，优先使用 OpenClaw 原生 Cron。以下是**需自行审核后执行**的禁用状态示例，不会立即运行：

```sh
openclaw cron add \
  --name creator-daily --agent writer \
  --cron '0 9 * * *' --tz Asia/Shanghai \
  --session isolated --timeout-seconds 1800 --no-deliver --disabled \
  --message 'Use the three Creator Studio skills for one useful article in the requested editorial brief. Use a stable topicKey and a runKey combining creator-daily with today in Asia/Shanghai. Research within the authorized budget. If evidence is insufficient, report no_candidate and its reason. Review at most twice, then submit for human review. Never approve or publish.'
```

先补全编辑目标、权限、宿主研究工具和预算，人工验收一次运行后再启用。`--no-deliver` 避免与插件固定通知重复投递。调度幂等依赖稳定 `runKey`，不是对所有写作、搜索成本的去重保障。

## 开发与验证

```sh
npm test
npm run test:host
npm run pack:check
```

`npm test` 使用临时 SQLite、合成测试文档/图片和模拟子 Agent/渠道，覆盖版本、审批、去重、限额、竞态、导出、文件边界、HTML/Markdown 转义和真实 loopback HTTP 认证。子 Agent 回归验证新会话、无工具/无投递参数、会话与 harness 回执、完整结论读取、等待中状态、超时取消、清理失败以及停止时等待清理。无需付费密钥；执行环境需允许监听临时本机端口。

研究相关回归测试验证：没有可选研究集成时，用户资料及其未独立读取的说明能完整传入审核和导出；仅有热榜二手来源时，规则检查会在模型调用前阻止通过。它们不证明真实 Agent 会正确执行 Skill 的选路指令，后者仍需在使用者授权的环境中联调。

`npm run test:host` 需要已安装的 OpenClaw，在临时配置与 state 目录中运行真实加载器，核对 4 个工具和 3 个可用 Skill 后清理。可用 `node test/host-smoke.js /absolute/path/to/unpacked/package` 验证解包产物。它不启动 Gateway，不运行模型、渠道或真实 Cron，也不验证线上 Gateway 已生效。

未执行真实付费子 Agent 审核、渠道发送、公众号导入或外网代理部署。子 Agent 生命周期已用模拟宿主验证，加载测试不证明生产 Gateway 的子 Agent 联调已通过；仍需在使用者自己的账户和授权下验收。使用 Node 内置 SQLite，首次加载可能显示其上游 experimental warning。

MIT License，见 [LICENSE](LICENSE)。
