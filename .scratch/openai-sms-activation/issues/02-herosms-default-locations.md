# 02 — 配置 HeroSMS 与默认候选地区

**What to build:** 管理员能够查看 HeroSMS 连接和余额，并配置 OpenAI 默认的三个候选地区。设置页展示当前价格与库存，默认值只影响之后创建的激活授权。

**Blocked by:** 01 — 建立可登录的应用骨架

**Status:** resolved

- [x] HeroSMS adapter 通过服务端 Secret 查询余额、服务、地区和报价
- [x] OpenAI 服务代码通过部署配置或已确认供应商数据提供
- [x] 设置页显示连接状态、余额、地区中文名称、价格和库存
- [x] 默认候选地区必须恰好三个、互不重复且可查询；瞬时库存不阻止保存
- [x] 修改默认候选地区不改变已有激活授权
- [x] API 密钥和完整供应商请求 URL 不进入页面或日志
- [x] adapter 契约测试覆盖余额、报价、地区、兼容文本和 JSON 成功与错误响应

## Comments

- 2026-07-31：已实现 HeroSMS HTTP adapter、部署配置、默认候选地区持久化和已认证设置页。默认地区只写入独立的全局配置表，不会修改激活授权；后续授权创建时复制候选地区由 issue #03 覆盖。已执行 `npm run typecheck`、`npm run build` 和 `npm test`；本机未设置 `TEST_DATABASE_URL`，两个 PostgreSQL 集成测试明确跳过，需在 Compose 或 CI 中设置该变量后执行真实数据库验收。
- 2026-07-31：已完成双轴代码审查并修正报价精度、OpenAPI 契约 fixture 和管理页面重复壳层。
- 2026-07-31：PostgreSQL Docker 服务就绪后，使用独立测试库 `sms_website_test` 执行 `TEST_DATABASE_URL=postgres://sms_website:local-development-only@127.0.0.1:5432/sms_website_test node --import tsx --test --test-concurrency=1 test/admin-settings.integration.test.ts test/herosms.test.ts`；2 项默认候选地区真实 PostgreSQL 集成测试及 9 项 HeroSMS adapter 契约测试全部通过。
