# 运维：到 svyun 查生产 Docker 日志

排查生产问题（如短信送达延迟、webhook 是否被丢弃、轮询兜底是否捡回）时，按本流程只读查看生产日志。本流程仅做只读查看，不修改任何配置、不重启容器；写操作（改 `.env.prod`、轮换密钥、重启服务）必须先与人工确认后再执行。

## 前提

- SSH 别名 `svyun` 已在本地 `~/.ssh/config` 配好，直接 `ssh svyun` 可登录。
- 生产部署路径固定为 `/opt/sms-activation-hub`（与 `README.md` 的「生产部署」一致）。
- 日志走应用 `process.stdout`，前缀统一为 `[herosms][level]`；不引入日志库、不写日志文件。`[herosms]` 行是排查短信链路的唯一通道。

## 基本命令

以下命令都在 svyun 上的 `/opt/sms-activation-hub` 目录执行。

### 连通性与容器状态

```sh
ssh svyun
cd /opt/sms-activation-hub
docker compose -f compose.prod.yaml ps --format "table {{.Name}}\t{{.Status}}"
```

期望：`sms-activation-hub-app-1` 与 `sms-activation-hub-postgres-1` 均为 `Up ... (healthy)`。

### 实时跟踪 app 日志

```sh
docker compose -f compose.prod.yaml logs -f app
```

### 按 `[herosms]` 前缀过滤短信链路日志

```sh
docker compose -f compose.prod.yaml logs --since 30m app | grep '\[herosms\]'
```

时间窗常用值：`--since 10m` / `--since 1h` / `--since "2026-08-07T01:00:00"`。

### 触发一次 webhook 后立即核对

人工（或由 HeroSMS 平台）触发一次 webhook 回调后，紧接着抓最近几分钟的 `[herosms]` 行即可看到该次请求的结果分类与最终 HTTP 码：

```sh
docker compose -f compose.prod.yaml logs --since 2m app | grep '\[herosms\]'
```

## 结果分类口径（对照 `sms-delivery-delay-mitigation` spec）

webhook 入口审计日志的一次请求会落到以下分类之一，事后据此判定某次送达走的是哪条路径：

- **拒绝（非白名单）** + HTTP 404：非白名单来源 IP 被静默丢弃。
- **429**：命中每分钟请求限流阈值。
- **400**：body 缺字段或时间解析失败；若 activationId 可解析则一并记录。
- **accepted** / **ignored**：业务接受或忽略，含 activationId 与结果分类。

凭这些行即可区分「HeroSMS 未推送」「被非白名单 404 静默丢弃」「触发限流 429」「body 无效 400」「业务接受 / 业务忽略」，不必再反推 `hero_sms_events.created_at`。

## 注意事项

1. **只读**：本流程只 `logs` / `ps` / `grep`。涉及 `.env.prod`、密钥轮换、`docker compose ... up -d` 重启等写操作，先与人工确认。
2. **日志驱动无轮转**：`compose.prod.yaml` 未配 `logging:`，app 容器走 Docker 默认 `json-file` 且 `Config` 为空（无 `max-size` / `max-file`）。当前阶段应用只在事件发生时打 stdout，空闲期日志文件为 0 字节，故无需轮转；若日后稳态日志增长，应在 `compose.prod.yaml` 的 `app` 服务下补 `logging.options.max-size` / `max-file`，不在本排查流程内临时处理。
3. **空闲期无输出属正常**：`docker compose logs app --tail 5` 在无 webhook / 无轮询事件时可能返回空，不代表容器异常；以 `ps` 的 `(healthy)` 为健康判据。
4. **历史日志回看**：因驱动为 `json-file` 且无轮转，历史日志在容器重建前一直保留；`docker compose ... up -d` 重建容器会清空 json-file 历史，排查时如需保留旧日志，重建前先 `docker compose -f compose.prod.yaml logs app > /tmp/app-snapshot.log`。