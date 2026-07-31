# 本地运行

## 前置条件

需要 Node.js 22+、Docker Compose 和一个支持 HTTPS 的反向代理。管理员密码、会话秘密、HeroSMS API 密钥和 OpenAI 服务代码只放在权限为 `600` 的 `.env` 文件中：

```sh
cp .env.example .env
chmod 600 .env
docker compose up -d postgres
npm install
npm run dev
```

开发环境的 PostgreSQL 地址使用 `.env.example` 中的 `DATABASE_URL`。生产环境必须替换 Compose 默认数据库密码、`ADMIN_PASSWORD`、`SESSION_SECRET`、`HEROSMS_API_KEY`，并将 `OPENAI_SERVICE_CODE` 填为已通过 HeroSMS 服务列表确认的 OpenAI 服务代码；应用和日志不会输出 API 密钥或供应商请求 URL。还需为实际反向代理配置 `TRUSTED_PROXY` 的 IP 或 CIDR；应用仅信任这些代理传递的客户端地址。通过反向代理将 HTTPS 转发到应用端口。应用只在 `/$ADMIN_PATH` 提供管理员入口；根路径与常见后台路径故意返回 `404`。

## 验证

```sh
npm run typecheck
npm test
```

`npm test` 会连接 PostgreSQL，创建名称随机的隔离测试数据库，运行完整测试，并在成功或失败后强制删除该数据库。测试不会再复用应用数据库，因此历史授权和未完成对账不会污染后续运行。

本地开发时，如果 `.env` 中的 `DATABASE_URL` 指向 `127.0.0.1`、`localhost` 或 `::1`，测试运行器会复用该服务器连接来创建临时数据库。CI 或远程 PostgreSQL 必须显式设置 `TEST_DATABASE_ADMIN_URL`；该账号需要 `CREATE DATABASE` 和 `DROP DATABASE` 权限。测试运行器拒绝隐式使用远程 `DATABASE_URL`。

其他测试入口：

```sh
# 不需要 PostgreSQL 的快速测试
npm run test:unit

# 底层 Node 测试入口，仅供测试运行器或专项排查使用；必须自行提供 TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://... npm run test:node
```

缺少 `TEST_DATABASE_URL` 时，数据库集成测试会失败而不是静默跳过，防止不完整的测试结果被误认为全部通过。
