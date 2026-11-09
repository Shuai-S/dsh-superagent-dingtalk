# Changelog

本文件记录 dsh-superagent-dingtalk 的显著变更，人可读、按版本分段。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本（SemVer）。

## [Unreleased]

### Added
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
