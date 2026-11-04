# dsh-superagent-dingtalk

钉钉直连 Source 插件：Stream 模式长连接实时接收机器人消息（群内 @ 或单聊），
走 superagent 引擎标准 准入→评估→Ticket→执行 链路，回复经 OpenAPI 直接回钉钉。

## 安装（superagent profile）

```sh
pnpm install && pnpm check
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent restart   # 在 dsh-superagent-prototype 内
```

## 配置（面板 Settings → 来源 → 钉钉机器人）

1. [open-dev.dingtalk.com](https://open-dev.dingtalk.com) 创建企业内部应用，添加机器人能力（消息接收模式选 Stream 模式）并发布
2. 填入 AppKey（Client ID）、AppSecret（Client Secret）、RobotCode
3. 添加要接收的群（openConversationId 以 cid 开头，群内发一条消息后可在机器人事件里看到）
4. Policy 里把允许派活成员的 staffId 加入白名单

AppSecret 明文存于引擎本地配置（sqlite，仅本机可读）；后续可加凭据绑定方案。
