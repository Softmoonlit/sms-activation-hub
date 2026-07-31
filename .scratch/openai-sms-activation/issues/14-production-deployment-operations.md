# 14 — 完成生产部署与运维说明

**What to build:** 提供单台 Linux VPS 的生产 Docker Compose 部署，通过 HTTPS 暴露接收者页面、隐藏后台入口和 HeroSMS Webhook，并提供管理员可执行的配置、更新、备份和恢复流程。

**Blocked by:** 13 — 执行发布级浏览器验收

**Status:** ready-for-agent

- [ ] 生产部署启动应用、PostgreSQL 和 HTTPS 反向代理并提供健康检查
- [ ] 部署配置模板说明 HeroSMS Secret、OpenAI 服务代码、管理员密码和后台路径
- [ ] 真实部署 Secret 不进入 Git，宿主机凭证文件权限为 `600`
- [ ] Webhook 秘密路径和来源 IP 白名单可按环境配置
- [ ] 应用重启后恢复队列、轮询、延迟取消和供应商对账
- [ ] 提供选择性手动备份命令，排除敏感交付数据和部署 Secret
- [ ] 提供恢复验证、密码变更、后台路径更换和 HeroSMS Secret 轮换步骤
- [ ] 生产形态下完成不调用真实 HeroSMS 的冒烟验证
