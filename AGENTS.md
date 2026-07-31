## Agent skills

### Issue tracker

规格和 issue 使用 `.scratch/` 下的本地 Markdown 文件管理。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认 triage 标签词汇。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用单上下文领域文档布局。详见 `docs/agents/domain.md`。

### 测试数据库

所有自动化数据库测试入口必须遵循 `README.md` 的隔离数据库原则：上层测试命令自动创建并清理随机临时数据库；底层入口必须显式接收 `TEST_DATABASE_URL`，缺失时明确失败，禁止静默跳过或复用应用数据库。
