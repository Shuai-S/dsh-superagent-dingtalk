# Changelog

本文件记录 dsh-superagent-dingtalk 的显著变更，人可读、按版本分段。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本（SemVer）。

## [Unreleased]

### Added
- ACL 访问模式（契约 docs/rpc-contract.md §3）：配置增可选 `policy`（`{mode:'allowlist'|'open', allowUsers, groupOnly?, denyText?:{zh,en}}`；不设 = 全放行向后兼容，形状非法按 schema 拒绝不做静默降级）；vendored `tools/acl/acl.ts` → `src/acl.ts`（纯函数判定，零 npm 依赖）；判定在派发（source.receive）之前、按机器人维度 deny 计数：拒绝经 robot 文本消息回执 denyText（群消息回群、单聊回单聊，与回复同路径语义），回执失败只记 stderr 不入 failure-log（ACL 拒绝不是发送失败）；健康计数 detail 增 `deny=`。会话类型不取 conversationType 字段（本环境不可信），按 chats 配置推断——已登记群 = group，其余 = single。
- 主动投递（契约 §2，P-B）：inject 增 `webServer`（dingtalk 首次引入；seam 不在时 log 一次并跳过路由注册，不崩启动）；路由前缀 `/dsh-dingtalk/api`——`POST /deliver`（`{targetId,text,kind?}` 构造非人类 Trigger（`human:false`、`meta.deliver:true`、`addressed:'direct'`、actor=`deliver`）交 `source.receive()`；400/404/409/受理语义按契约；单聊目标走 robot.directMessages 闸门、群目标须已登记 chats，与入站同规则）、`POST /deliver/test`（不经引擎直调 sendRobotMessage（oTo/group 端点）发双语测试文案，返回 `{ok,sent,detail}`）、`GET /health`（状态 + 机器人合计 in/out/fail/deny 计数 + 最近 20 条 failure-log + dedup 水位）；目标表 `~/.local/state/dsh-superagent-dingtalk/targets.json`（targetId 1–128 字符 `[A-Za-z0-9._@:-]`，tmp+rename 原子写；目标管理 UI 属 P-C'）。
- 主动投递引擎侧配置前提（实读引擎 src/policy.ts machineGate / src/sources/registry.ts，2026-11-09，引擎升级后需复核）：非人类 Trigger 过引擎 machineGate——settings 里 `policy.sources.dingtalk.bots` 需列出投递 actor（本包恒为 `{ "id": "deliver" }`）且 `eval.mode ≠ "off"`，否则以 `not_human` 被静默忽略（auto 模式下 inferred 候选才转工单）；本包 deliver trigger 恒带 `addressed:'direct'`（machineGate 的 addressed 门）且 meta 带齐 dingtalk kind `scope()` 判 listened 所需字段（accountId / isDm / conversationId）。
- 测试：`test/acl.test.mjs`（判定纯函数：缺省放行 / 命中 / 未命中 / 大小写敏感 / groupOnly 兜底 / 拒绝回执文案）与 `test/deliver.test.mjs`（targets 读写 / 原子写 / targetId 校验 / 400 / 404 / 409 / 受理 trigger 形状断言（staffId 与 conversationId 双形状）/ deliver:test 发送桩 / health 水位 / sameOrigin 403，零网络）。
- verify-package.mjs 增路由契约探针：lib/index.js 含 `/dsh-dingtalk/api` 前缀串与 `/deliver` 字面量（防路由名漂移）；client bundle 探针 N/A（本包无 client bundle，「源设置」页壳属 P-C'）。
- 多机器人支持：配置改为 robots[] + chats[] 扁平结构，每个机器人各保持一条 Stream 长连接；trigger id、回复地址与准入表行都带机器人维度（rowId = RobotCode，缺省取 AppKey），两个机器人同群互不串扰；0.1.x 单机器人扁平配置自动迁移，无需手动改配置
- 渠道健壮性：
  - 持久化去重环（`~/.local/state/dsh-superagent-dingtalk/seen-<robot>.json`，FIFO 上限 1000，原子写）——Stream at-least-once 重推与进程重启后的重复消息在这里兜底
  - 回复超限自动切块（UTF-8 安全边界，切点优先级 空行 > 换行 > 空格 > 硬切，不劈多字节字符与代理对）；首块失败整条重试，后续块失败只记日志不整条重发，避免已送达前文重复出现
  - 发送失败日志（`~/.local/state/dsh-superagent-dingtalk/send-failures.jsonl`，JSONL 上限 200 行，无凭据无正文）
  - 健康上报 detail 追加紧凑计数（`in=/out=/fail=/last=`，按机器人维度）
- 工程化：
  - CI 工作流（push main 与 PR 闸门：typecheck + build + test + 打包探针）
  - 打包完整性探针 scripts/verify-package.mjs（零依赖）
  - node:test 测试体系（配置 schema、纯函数、Trigger 映射、切块、去重、失败日志）
  - package.json 声明 dsh.compatibility（dsh 0.2.2-rc.1）
- media：图片/文件/视频/语音消息全链路——附件落盘注入 trigger 文本、图片 downloadCode 经 image() 下载注入会话

### Fixed
- accessToken 按机器人隔离缓存（单槽会让两个机器人互相踢掉对方的有效 token）
- 「思考中」表情按 robotCode+msgId 去重与撤回（同 msgId @ 两个机器人不再「撤了又回来」）
- webhook 回复检查 body.errcode（HTTP 200 不代表成功），失败自动回退 OpenAPI
- 健康上报改为以实际收到的消息判定连通性（beta SDK connected 标志重连后失真）

### Changed
- 未注册会话按单聊处理，免逐 cid 注册；回复通道改为 sessionWebhook 优先（官方示例模式），OpenAPI group/oTo 兜底

## [0.1.0] - 2026-11-04

### Added
- 首个版本：钉钉直连 Source 插件——Stream 模式长连接实时接收机器人消息（群内 @ 或单聊），走 superagent 引擎 准入→评估→Ticket→执行 链路，回复经 OpenAPI 直接回钉钉；「🤔思考中」表情反馈；面板配置与准入白名单。
