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
TEST_DATABASE_URL=postgres://sms_website:local-development-only@127.0.0.1:5432/sms_website npm test
```

集成测试只接受由 `TEST_DATABASE_URL` 显式指定的真实 PostgreSQL 测试库。未设置该变量时，测试会明确跳过，不会以内存数据库替代持久化行为，也不会意外连接应用运行库。
