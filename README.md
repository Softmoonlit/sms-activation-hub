# 临时短信激活授权平台 (SMS Activation Hub)

基于 Node.js / Fastify / PostgreSQL 开发的轻量级临时短信激活与验证码接收授权系统。支持接码平台（如 HeroSMS）对接与服务代码配置（预置 OpenAI 等服务支持）。

### 核心特性
- **管理员控制台**：批量生成待领取授权链接、动态配置 3 至 10 个默认候选位置、查询授权历史与成本对账、支持隐藏后台路径与密钥轮换。
- **接收者流程**：接收者无需注册账号，通过授权链接首次点击“获取号码”自动完成领取，原子复制当时配置的候选地区并启动 24 小时绝对期限；实时查看验证码、自动重试与换号。
- **隐私与安全**：根路径及常见后台隐蔽返回 404，敏感数据（号码/验证码/短信全文）在流程结束后自动擦除。

---

## 本地运行

## 前置条件

需要 Node.js 22+、Docker Compose 和一个支持 HTTPS 的反向代理。管理员密码、会话秘密、HeroSMS API 密钥和服务代码只放在权限为 `600` 的 `.env` 文件中：

```sh
cp .env.example .env
chmod 600 .env
docker compose up -d postgres
npm install
npm run dev
```

开发环境的 PostgreSQL 地址使用 `.env.example` 中的 `DATABASE_URL`。生产环境必须替换 Compose 默认数据库密码、`ADMIN_PASSWORD`、`SESSION_SECRET`、`HEROSMS_API_KEY`，并将 `OPENAI_SERVICE_CODE` 填为已通过 HeroSMS 服务列表确认的服务代码（如 OpenAI 对应的代码）；应用和日志不会输出 API 密钥或供应商请求 URL。还需为实际反向代理配置 `TRUSTED_PROXY` 的 IP 或 CIDR；应用仅信任这些代理传递的客户端地址。通过反向代理将 HTTPS 转发到应用端口。应用只在 `/$ADMIN_PATH` 提供管理员入口；根路径与常见后台路径故意返回 `404`。

## 验证

```sh
npm run typecheck
npm test
npm run test:e2e
```

`npm test` 和 `npm run test:e2e` 都会连接 PostgreSQL，分别为 Node.js 测试和 Playwright 浏览器测试创建名称随机的隔离测试数据库，并在成功或失败后强制删除该数据库。测试不会复用应用数据库，因此历史授权和未完成对账不会污染后续运行。

本地开发时，如果 `.env` 中的 `DATABASE_URL` 指向 `127.0.0.1`、`localhost` 或 `::1`，测试运行器会复用该服务器连接来创建临时数据库。CI 或远程 PostgreSQL 必须显式设置 `TEST_DATABASE_ADMIN_URL`；该账号需要 `CREATE DATABASE` 和 `DROP DATABASE` 权限。测试运行器拒绝隐式使用远程 `DATABASE_URL`。

其他测试入口：

```sh
# 不需要 PostgreSQL 的快速测试
npm run test:unit

# 底层 Node 测试入口，仅供测试运行器或专项排查使用；必须自行提供 TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://... npm run test:node

# 底层 Playwright 入口同样必须自行提供 TEST_DATABASE_URL；通常应使用 npm run test:e2e
TEST_DATABASE_URL=postgres://... npx playwright test
```

缺少 `TEST_DATABASE_URL` 时，数据库集成测试和 Playwright 浏览器测试都会失败而不是静默跳过，防止不完整的测试结果被误认为全部通过。以后新增的任何数据库测试入口也必须复用同一隔离数据库运行原则：自动化入口负责创建和清理临时数据库，底层入口缺少 `TEST_DATABASE_URL` 时明确失败。

---

# 生产部署

## 前置条件

- 一台运行 Ubuntu/Debian 的 Linux VPS，已安装 Docker 和 Docker Compose V2
- 域名 DNS 已解析到 VPS 公网 IP（以下以 `sms.example.com` 为占位符）

## 初始部署

### 1. 克隆代码

```sh
git clone <repo-url> /opt/sms-activation-hub
cd /opt/sms-activation-hub
```

### 2. 准备配置文件

```sh
cp .env.prod.example .env.prod
chmod 600 .env.prod
# 编辑 .env.prod，替换所有 replace-* 占位符为真实值
# PUBLIC_ORIGIN=https://sms.example.com
# TRUSTED_PROXY=127.0.0.1,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16（Caddy 在宿主机 + Docker 部署）

# PostgreSQL 容器仅需一个密钥文件，避免应用密钥注入数据库容器
cp .env.postgres.prod.example .env.postgres.prod
chmod 600 .env.postgres.prod
# 编辑 .env.postgres.prod，将 POSTGRES_PASSWORD 设为与 .env.prod 中相同的密码
```

`.env.prod` 和 `.env.postgres.prod` 包含所有敏感密钥，不会进入 Git（已加入 `.gitignore`）。

### 3. 安装并配置宿主机 Caddy

Caddy 作为 systemd 服务安装在宿主机，不放入容器：

```sh
sudo apt install -y caddy
```

创建 `/etc/caddy/Caddyfile`，将 `sms.example.com` 替换为实际域名：

```caddy
sms.example.com {
    reverse_proxy localhost:3001
}
```

应用配置并启用 Caddy：

```sh
sudo systemctl enable --now caddy
sudo caddy reload --config /etc/caddy/Caddyfile
```

Caddy 会自动申请并续期 Let's Encrypt TLS 证书。

### 4. 启动应用

```sh
docker compose -f compose.prod.yaml up -d --build
```

首次启动时，应用会在启动时自动建表（不需要单独运行 migration runner）。查看日志：

```sh
docker compose -f compose.prod.yaml logs -f
```

### 5. 冒烟验证（WSL2 / VPS 均适用）

等待容器健康检查通过后（约 30 秒），验证基本 HTTP 响应：

```sh
# 验证应用在容器网络内正常响应
docker compose -f compose.prod.yaml ps          # 检查 Status 为 healthy
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/
# 期望：404（根路径故意返回 404）

curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health
# 期望：200
```

> **WSL2 冒烟验证说明**：在 WSL2 上只需验证 Docker Compose 启动、健康检查和基本 HTTP 响应；Caddy + HTTPS 部分到真实 VPS 上再验证。

## 更新应用

```sh
cd /opt/sms-activation-hub
git pull origin main
docker compose -f compose.prod.yaml up -d --build
```

`--build` 会重新构建镜像；`-d` 后台运行。旧容器会在新容器健康后被替换。

### 收缩迁移的前置检查

历史版本升级到收缩模型时，启动迁移会先检查是否存在未完结的旧模型激活授权（旧 `in_progress`/`result_available` 等仍绑定接收者标识或创建期限的记录）。若发现此类记录，应用会启动失败并打印：

```text
存在未完结的旧模型激活授权，收缩迁移无法安全继续
```

此时不要删除数据：先由管理员在**旧版本**上处理完这些未完结记录（等待领取、结束使用或撤销），确认没有未完结记录后重新启动。迁移完成后旧撤销与旧到期记录收敛为"已结束"且不可访问，原链接一律返回 404。

旧模型下保存的"仅地区 ID"候选配置（缺少地区名称）会在迁移中删除对应位置，升级后管理员需在设置页重新保存三个候选地区。

## 密钥轮换

### 更换管理员密码（`ADMIN_PASSWORD`）

```sh
# 编辑 .env.prod，修改 ADMIN_PASSWORD 为新密码
vim .env.prod
docker compose -f compose.prod.yaml up -d app
```

已登录的管理员会话下次请求时因密码哈希变化而失效，需重新登录。

### 更换后台路径（`ADMIN_PATH`）

```sh
# 编辑 .env.prod，修改 ADMIN_PATH 为新路径（6~12 位字母或数字）
vim .env.prod
docker compose -f compose.prod.yaml up -d app
```

旧路径立即停止响应，已有会话无效。告知管理员新路径后再操作。

### 轮换 HeroSMS Webhook Secret（`HEROSMS_WEBHOOK_PATH`）

1. 在 HeroSMS 后台更新 Webhook URL 为新路径
2. 编辑 `.env.prod`，更新 `HEROSMS_WEBHOOK_PATH`
3. 重启应用：`docker compose -f compose.prod.yaml up -d app`

轮换期间（步骤 1→3 之间）HeroSMS 回调会短暂失败；建议在业务低峰期操作。

### 轮换 HeroSMS API 密钥（`HEROSMS_API_KEY`）

1. 在 HeroSMS 平台重新生成 API 密钥
2. 编辑 `.env.prod`，更新 `HEROSMS_API_KEY`
3. 重启应用：`docker compose -f compose.prod.yaml up -d app`

### 轮换会话密钥（`SESSION_SECRET`）

```sh
vim .env.prod  # 更新 SESSION_SECRET
docker compose -f compose.prod.yaml up -d app
```

所有在线会话立即失效，管理员需重新登录。

### 更换 PostgreSQL 密码（`POSTGRES_PASSWORD`）

PostgreSQL 密码同时出现在 `DATABASE_URL` 和 `POSTGRES_PASSWORD` 两个变量中，轮换步骤：

```sh
# 1. 进入数据库容器修改密码
docker compose -f compose.prod.yaml exec postgres \
  psql -U sms_website -c "ALTER USER sms_website PASSWORD 'new-strong-password';"

# 2. 编辑 .env.prod，同步更新 DATABASE_URL 和 POSTGRES_PASSWORD
vim .env.prod

# 3. 编辑 .env.postgres.prod，同步更新 POSTGRES_PASSWORD
vim .env.postgres.prod

# 4. 重启应用以使用新密码
docker compose -f compose.prod.yaml up -d
```

## 数据持久化

数据库数据保存在 Docker named volume `sms-activation-hub_postgres-data` 中，`docker compose down` 不会删除它。如需彻底清除：

```sh
docker compose -f compose.prod.yaml down -v  # 危险：删除数据库数据
```
