<div align="center">

# ◆ MJ Code

**An open-source terminal coding agent with intelligence, verification, and repair.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime_deps-0-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![GitHub Stars](https://img.shields.io/badge/dynamic/json?color=yellow&label=stars&query=stargazers_count&url=https://api.github.com/repos/xemj9/mj-code)](https://github.com/xemj9/mj-code)

*Think deeper. Verify everything. Repair automatically.*

</div>

---

## � 为什么选择 MJ Code？

### 🎯 解决核心痛点

- **传统 Coding Agent 太"傻"**：Prompt → LLM → Tool → Done，没有验证，没有修复，出了问题就报错
- **MJ Code 三级智能增强**：任务感知（Perception）→ 执行规划（Planning）→ 自动验证修复（Verification），确保每一步都正确
- **零运行时依赖**：仅需 Node.js ≥ 20，无需安装任何 npm 包即可运行（`tsx` 和 `typescript` 仅开发时用）
- **类 Claude Code 体验**：终端 REPL 交互、命令面板、上下文压缩、Session 持久化，全套工业级 Agent 体验

### 🌟 技术优势

| 特性 | 传统 Coding Agent | MJ Code |
|------|------------------|---------|
| **任务理解** | 直接生成 | 12 类任务分类 + 能力路由 |
| **执行策略** | 自由生成 | 依赖感知的执行计划图 |
| **代码验证** | 无 | TypeScript 诊断 + 测试 + 自动修复 |
| **运行时依赖** | 数百个 npm 包 | 零 |
| **Memory 系统** | 无或简单 | 多维记忆（重要性/时效/任务相关/确定性） |
| **回滚能力** | 无 | Checkpoint + Undo |
| **策略透明度** | 硬编码 | 5 层可审计策略栈 |

---

## 🚀 快速开始

```bash
# 一键安装运行
git clone https://github.com/xemj9/mj-code.git
cd mj-code
npm install

# 设置 API Key（支持 OpenAI 兼容或 Anthropic 端点）
export OPENAI_API_KEY="sk-..."

# 启动
npm start
```

### 全局安装

```bash
npm install -g .
mj-code
```

### 配置

```bash
# 方式 1：环境变量（推荐）
export OPENAI_API_KEY="your-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o"

# 方式 2：Anthropic Claude
export ANTHROPIC_API_KEY="your-key"
export ANTHROPIC_MODEL="claude-sonnet-4-20250514"

# 方式 3：配置文件
cp mjcode.config.example.json mjcode.config.json
# 编辑 mjcode.config.json 填入你的配置
```

### 使用方式

```bash
# 交互式 REPL（默认，最常用）
mj-code

# 一次性任务
mj-code run "Explain the architecture of this project"

# 指定 provider 和 model
mj-code run "Fix the TypeScript errors" --provider openai-compatible --model gpt-4o

# 使用 Anthropic
mj-code run "Refactor the auth module" --provider anthropic-compatible --model claude-sonnet-4-20250514
```

### REPL 内命令

```
/              → 命令面板（↑↓ 导航，↵ 选择，esc 关闭）
/status        → 查看 Agent 当前状态
/effort <level>→ 设置推理深度（low|medium|high|max）
/why           → 解释最近的路由/规划决策
/plan          → 展示执行计划
/compact       → 压缩对话上下文
/cost          → 查看 Token 用量和成本
/memory        → 查看存储的记忆和项目事实
/undo          → 回滚上一次修改
/history       → 浏览会话历史
/clear         → 清空对话
/about         → 项目信息
/exit          → 退出
```

---

## ✨ 核心架构

MJ Code 在传统 Agent 循环之上增加了**三级智能增强**：

```
传统 Agent:  Prompt → LLM → Tool → Done（祈祷不出错）
MJ Code:     Prompt → 分类 → 路由 → 规划 → 执行 → 验证 → 修复 → Done ✓
```

| 层级 | 功能 | 价值 |
|------|------|------|
| 🧠 **Perception（感知）** | 任务分类 → 能力路由 → 模型路由 | Agent 在开始前就知道：你要什么、有哪些工具、用哪个模型 |
| 📋 **Planning（规划）** | 依赖感知的执行图 + 重规划 | 按结构化计划执行，出错就重规划，不是自由生成 |
| ✅ **Verification（验证）** | TypeScript 诊断 + 测试 + 自动修复 | Agent 验证每次编辑。如果出错，自动修复后再报告 |

### 架构全景

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI / 交互式 REPL                          │
│              ◆ MJ Code · 终端编程 Agent                      │
├─────────────────────────────────────────────────────────────┤
│                    Agent Turn Engine                          │
│   ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐ │
│   │ 分类任务  │→│  能力路由  │→│  模型选择  │→│ 执行+工具 │ │
│   └──────────┘  └───────────┘  └──────────┘  └──────────┘ │
│                        ↓                          ↓         │
│                 ┌───────────┐            ┌───────────────┐  │
│                 │  执行计划  │            │ 验证+修复循环  │  │
│                 │   图      │            │               │  │
│                 └───────────┘            └───────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  内置工具 │ Web 工具 │ MCP 工具 │ 插件 │ Skills（技能）      │
├─────────────────────────────────────────────────────────────┤
│  Session │ Memory │ ChangeSet │ Rollback │ Journal │ Health  │
├─────────────────────────────────────────────────────────────┤
│  OpenAI 兼容 │ Anthropic 兼容 │ Mock 提供者                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔍 核心功能

### 🧠 智能决策管道

每个 Prompt 在执行前都经过结构化决策管道：

1. **任务分类** — 12 个类别（`code_edit`、`bug_fix`、`refactor`、`web_retrieval` 等）
2. **能力路由** — 根据运行时健康、权限和网络模式选择可用工具
3. **模型路由** — 为任务类型选择最佳模型，带自动回退链
4. **执行规划** — 构建依赖图，不是扁平列表
5. **验证 + 修复** — 每次编辑后验证结果，自动修复

### ✅ 验证器 + 修复循环

最关键的差异化能力。每次代码编辑后：

```
编辑 → 验证器
        ├─ TypeScript 诊断（通过 tsserver transport）
        ├─ 语法检查
        └─ 测试执行（如检测到 test/lint 命令）

      → 如果验证失败：
        ├─ 收集诊断增量（新增/改善/回退错误）
        ├─ 从 tsserver 获取修复提示 + code actions
        ├─ 生成结构化修复指令
        └─ 修复循环（有界自动修复，默认 1 次尝试）
             → 重新验证 → 收敛或诚实报告
```

### 🛡️ 策略栈

System Prompt 通过可审计的 5 层策略栈组装，不是硬编码的字符串：

```
核心策略           （不可变基础规则）
  + 项目指令        （来自 MJ.md 文件）
  + Skill 策略      （来自活跃 Skills）
  + 用户偏好        （来自配置）
  + 运行时策略      （降级状态、健康检查）
= 有效策略          （最终 System Prompt，可通过 /why 查看）
```

### 🎨 终端 UI

- **ASCII Art Banner** 展示 provider 和 effort level
- **用户/AI 对话气泡** 带圆角边框和颜色标记
- **工具调用面板** 按作用域颜色编码（读=蓝、写=黄、网络=紫、Shell=红）
- **交互式命令面板** 支持 ↑↓ 导航、输入过滤、↵ 选择
- **动画加载指示器** AI 思考时显示
- **上下文窗口进度条**
- **Effort Level 指示器** 带颜色编码

### 🔌 可扩展性

| 扩展方式 | 说明 |
|---------|------|
| **Skills（技能）** | Prompt 片段 + 工具偏好 + 工作流提示（5 个内置） |
| **Plugins（插件）** | 本地 JS 模块，注册自定义工具 |
| **MCP** | Model Context Protocol 客户端，支持 stdio transport |
| **Web** | 搜索、抓取、提取，带可信来源排序和引用 |

### 📦 零运行时依赖

仅需 Node.js ≥ 20，**零 npm 运行时依赖**。仅 `tsx` 和 `typescript` 作为开发依赖。

---

## 🛠️ 内置 Skills

| Skill | 用途 |
|-------|------|
| `repo-maintainer` | 精准编辑、测试、README 同步 |
| `docs-research` | 官方文档、引用、来源排序 |
| `bug-hunter` | 系统化 Bug 诊断和修复 |
| `code-reviewer` | 结构化代码审查（只读） |
| `test-writer` | 测试生成和覆盖率 |

```bash
mj-code skills enable bug-hunter
# 或在 REPL 内：/skill enable bug-hunter
```

---

## 🔧 Web 知识平面

```bash
# 安全默认：仅官方文档
export MJ_CODE_NETWORK_MODE="docs-only"

# 完整 Web 访问
export MJ_CODE_NETWORK_MODE="open-web"

# 从 REPL 搜索
/search OpenAI function calling API
/fetch https://docs.anthropic.com/en/docs/build-with-claude/tool-use
```

网络模式：`off` | `docs-only` | `open-web`

---

## 🔗 MCP 集成

```json
// .mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./my-mcp-server.mjs"],
      "enabled": true
    }
  }
}
```

MCP 工具自动发现和映射：`mcp__my-server__my-tool`

---

## 📁 项目结构

```
mj-code/
├── src/                          # 源代码
│   ├── cli.mjs                   # CLI 入口
│   ├── cli-main.mts              # 主入口逻辑
│   ├── cli-runtime.mts           # 运行时启动
│   ├── agent.mts                 # Agent 核心
│   ├── lib/                      # 核心库（100+ 模块）
│   │   ├── agent-loop.mts        # Agent 主循环
│   │   ├── agent-turn-engine.mts # Turn 引擎
│   │   ├── agent-verifier.mts   # 验证器
│   │   ├── agent-repair-loop.mts # 修复循环
│   │   ├── agent-policy.mts      # 策略栈
│   │   ├── agent-plan-*.mts      # 规划系统
│   │   ├── agent-decision-*.mts  # 决策系统
│   │   ├── agent-session-*.mts   # 会话管理
│   │   ├── agent-memory.mts      # 记忆系统
│   │   ├── agent-observability.mts # 可观测性
│   │   ├── model-router.mts      # 模型路由
│   │   ├── capability-router.mts # 能力路由
│   │   ├── task-classifier.mts   # 任务分类
│   │   ├── permissions.mts       # 权限系统
│   │   ├── policy-stack.mts      # 策略栈
│   │   ├── risk-engine.mts       # 风险评估
│   │   ├── circuit-breaker.mts   # 熔断器
│   │   ├── mcp-client.mts        # MCP 客户端
│   │   ├── web-runtime.mts       # Web 运行时
│   │   ├── shell-runtime.mts     # Shell 运行时
│   │   ├── interactive-shell-*.mts # 交互式 Shell
│   │   ├── plugin-loader.mts     # 插件加载器
│   │   ├── skill-loader.mts      # Skill 加载器
│   │   └── ...
│   ├── providers/                # 模型提供者
│   │   ├── openai-compatible.mts
│   │   ├── anthropic-compatible.mts
│   │   └── mock.mts
│   ├── tools/                    # 内置工具
│   │   ├── filesystem.mts        # 文件操作
│   │   ├── patch.mts             # 结构化补丁
│   │   ├── shell.mjs             # Shell 执行
│   │   ├── web.mts               # Web 搜索
│   │   └── memory.mjs            # 记忆操作
│   ├── builtin/skills/           # 内置 Skills
│   │   ├── bug-hunter/
│   │   ├── code-reviewer/
│   │   ├── docs-research/
│   │   ├── repo-maintainer/
│   │   └── test-writer/
│   └── types/                    # 类型定义
├── test/                         # 测试（60+ 测试文件）
├── docs/                         # 技术文档
├── fixtures/                     # 测试夹具
├── scripts/                      # 工具脚本
├── package.json
├── mjcode.config.example.json    # 配置示例
└── MJ.md                         # 项目指令
```

---

## 🧪 开发

```bash
npm install            # 安装依赖
npm run dev            # 开发模式运行（无需构建）
npm run build          # 生产构建
npm run typecheck      # 类型检查
npm test               # 运行测试
npm run smoke:mock     # Mock provider 冒烟测试
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 👨‍💻 作者

**谢明锦 / Xie Mingjin**

[![GitHub](https://img.shields.io/badge/GitHub-xemj9-blue?style=for-the-badge&logo=github)](https://github.com/xemj9)
[![Email](https://img.shields.io/badge/Email-785631669@qq.com-red?style=for-the-badge&logo=gmail)](mailto:785631669@qq.com)

*广东 · 中山大学*

---

## 📄 许可证

MIT — 详见 [LICENSE](./LICENSE)。

---

## ⚖️ 伦理准则

MJ Code 遵循设计者制定的伦理准则，详见 [ETHICS.md](./ETHICS.md)。

核心原则：
- **诚信第一** — 拒绝有害、非法或欺诈性请求
- **善良负责** — 保护用户，行动前验证，不隐藏错误
- **技术卓越** — 严格标准，追求正确性
- **公正** — 只做公正之事；不公正则拒绝

---

<div align="center">

**Designed by 谢明锦 / Xie Mingjin** · Guangdong · Sun Yat-sen University

*健康工作，快乐生活* · *顺颂时祺，得偿所愿*

[GitHub](https://github.com/xemj9) · [MultiAgent-Flow](https://github.com/xemj9/MultiAgent-Flow) · [SAM-Auto-Annotator](https://github.com/xemj9/sam-auto-annotator)

</div>