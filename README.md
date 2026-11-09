# dsh-superagent-dingtalk

钉钉直连 Source 插件：Stream 模式长连接实时接收机器人消息（群内 @ 或单聊），
走 superagent 引擎标准 准入→评估→Ticket→执行 链路，回复经 OpenAPI 直接回钉钉。
支持多机器人：每个机器人各保持一条 Stream 长连接，触发与回复都带机器人维度。

## 安装

```sh
# 从 npm 安装
dsh plugin --profile superagent add dsh-superagent-dingtalk

# 或从本地源码安装（开发场景）
dsh plugin --profile superagent add "link:$PWD"
```

安装后重启引擎生效。

## 配置（面板 Settings → 来源 → 钉钉机器人）

1. [open-dev.dingtalk.com](https://open-dev.dingtalk.com) 创建企业内部应用，添加机器人能力（消息接收模式选 Stream 模式）并发布
2. 在「钉钉机器人」里逐行添加机器人：AppKey（Client ID）、AppSecret（Client Secret）必填；RobotCode 一般与 AppKey 相同，留空按 AppKey 处理
3. 在「接收的群」里添加要接收的群（openConversationId 以 cid 开头，群内发一条消息后可在机器人事件里看到）；所属机器人填该机器人行的 RobotCode/AppKey，留空 = 第一行机器人
4. Policy 里把允许派活成员的 staffId 加入白名单

### 配置项

| 字段 | 说明 |
| --- | --- |
| robots[].clientId / appSecret | 应用凭证（AppKey/AppSecret），每机器人一行 |
| robots[].robotCode | 发消息必带；企业内部机器人默认与 AppKey 相同，可留空 |
| robots[].label | 面板显示名（可选） |
| robots[].directMessages | 接收单聊与未登记会话（按单聊处理，默认开） |
| robots[].thinkingEmotion | 「🤔思考中」表情反馈（默认开） |
| chats[].robot | 所属机器人的 RobotCode/AppKey 原文；留空 = 第一行机器人 |
| chats[].openConversationId / name | 会话 ID（cid 开头）与群名 |

### 多机器人语义

- 机器人身份以 rowId（RobotCode，缺省取 AppKey）唯一标识；trigger id、回复地址与准入表行都带该维度，两个机器人同群互不串扰
- 同一群聊可配给多个机器人：哪个机器人被 @ 就由哪个机器人派活，回复用它自己的凭据发送
- 凭据变更会重连该机器人的 Stream；群列表与开关改动实时生效，不触发重连
- 准入表按「机器人 × 群/单聊」出行（`rowId:cid` / `rowId:direct`），可分别控制各机器人的准入

### 从 0.1.x 升级

旧配置是单机器人扁平结构（clientId/appSecret/robotCode/chats/…），引擎读取时自动迁移为
一行机器人 + 原群列表（挂到该机器人）；无需手动改配置。旧 trigger/工单凭「仅一个机器人」
兜底继续有效，保存一次设置后即固化为新结构。

AppSecret 以明文保存在引擎本地配置（SQLite，仅限本机读取），不进入日志与会话记录。
