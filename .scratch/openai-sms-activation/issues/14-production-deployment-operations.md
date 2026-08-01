# 14 — 完成生产部署与运维说明

**What to build:** 提供单台 Linux VPS 的生产 Docker Compose 部署，通过主机 Caddy 反向代理提供 HTTPS，暴露接收者页面、隐藏后台入口和 HeroSMS Webhook，并提供管理员可执行的配置、更新和密钥轮换流程。

**Blocked by:** 13 — 执行发布级浏览器验收

**Status:** done

**架构决策（grill-me 对齐）：**
- 反向代理：Caddy 安装在 VPS 主机上（`apt install caddy`），作为 systemd 服务运行，不放容器
- 应用部署：多阶段 Dockerfile 构建镜像，compose 里 build
- Compose 文件：开发用 `compose.yaml`（已有，不动），生产用 `compose.prod.yaml`（新建）
- 敏感配置：`.env.prod` 文件通过 `env_file` 传入容器，不进 Git，权限 600；提供 `.env.prod.example` 模板
- 端口暴露：应用容器只绑定 `127.0.0.1:3000`，Caddy 反代到 `localhost:3000`
- 域名：文档中用占位符 `sms.example.com`，说明替换方法
- Caddy 配置：不在项目仓库中存放 Caddyfile，README 中写清安装 Caddy 和配置 Caddyfile 的步骤
- 数据持久化：Docker named volume
- 冒烟测试：WSL2 上只验证 Docker Compose 部分（应用+数据库），不安装 Caddy；Caddy + HTTPS 到 VPS 上验证

- [x] 多阶段 Dockerfile 构建生产镜像，`compose.prod.yaml` 启动应用和 PostgreSQL 并提供健康检查
- [x] `.env.prod.example` 部署配置模板说明 HeroSMS Secret、OpenAI 服务代码、管理员密码和后台路径
- [x] 真实部署 Secret 不进入 Git，宿主机 `.env.prod` 文件权限为 `600`
- [x] Webhook 秘密路径和来源 IP 白名单可按环境配置
- [x] 应用重启后恢复队列、轮询、延迟取消和供应商对账（前序 issue 已实现，此处确认生产 compose 重启后正常）
- [x] 提供密码变更、后台路径更换和 HeroSMS Secret 轮换步骤
- [x] 生产形态下完成不调用真实 HeroSMS 的冒烟验证（WSL2 上验证 Docker Compose 启动、健康检查和基本 HTTP 响应）
