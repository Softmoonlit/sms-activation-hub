# 01 — 建立可登录的应用骨架

**What to build:** 建立可运行的 TypeScript 单体应用和 PostgreSQL 持久层。管理员通过自定义隐藏入口使用部署密码登录，系统只保留一个活跃管理员会话。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 应用与 PostgreSQL 可在开发环境启动并提供健康检查
- [x] 后台入口从 6 至 12 位字母数字部署配置读取，常见后台名称被拒绝
- [x] 管理员可使用部署 Secret 中的密码登录，错误登录受到限速
- [x] 新登录、密码配置变化或应用重新初始化会撤销旧会话
- [x] 管理员会话最多有效 30 天且具备安全 Cookie 和 CSRF 防护
- [x] 根路径、常见后台路径和不存在页面返回 404
- [x] 真实 PostgreSQL 集成测试覆盖登录、单会话、过期和撤销

## Comments

- 2026-07-31：已实现 Fastify/TypeScript 单体、PostgreSQL 会话持久化和管理员登录骨架。`npm run typecheck`、`npm run build` 与 `npm test` 已运行；本机未配置 PostgreSQL，集成测试明确跳过，需在 Compose 或 CI 中设置 `TEST_DATABASE_URL` 后执行真实数据库验收。
- 2026-07-31：实现已提交并经双轴代码审查通过。
