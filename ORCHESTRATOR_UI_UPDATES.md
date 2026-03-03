# Orchestrator UI Updates - Specialization & Confidence Display

## 更新概述

UI界面已更新，显示新的specialization（专业化）和confidence（置信度）信息，让用户可以直观地看到Claude Code优化的效果。

## 更新的文件

### 1. ui/src/ui/controllers/orchestration.ts

**更新类型定义**:

```typescript
// 添加 specialization 字段
export type OrchestrationSubtask = {
  // ... 其他字段
  specialization:
    | "code-explorer"
    | "code-architect"
    | "code-implementer"
    | "code-reviewer"
    | "researcher"
    | "generic";
};

// 添加 confidence 和 issues 字段
export type OrchestrationAcceptanceVerdict = {
  subtaskId: string;
  passed: boolean;
  confidence: number; // 0-100
  reasoning?: string;
  issues?: Array<{
    severity: "critical" | "major" | "minor";
    confidence: number;
    description: string;
    file?: string;
    line?: number;
  }>;
};
```

### 2. ui/src/ui/components/task-card.ts

**添加specialization徽章显示**:

- 新增 `specializationBadge()` 函数
- 每种specialization有独特的图标和颜色：
  - 🔍 Explorer (蓝色) - 理解代码库
  - 🏗️ Architect (紫色) - 设计架构
  - ⚙️ Implementer (绿色) - 编写代码
  - 👁️ Reviewer (橙色) - 审查质量
  - 📚 Researcher (粉色) - 收集信息
  - 📋 Generic (灰色) - 通用任务

**任务卡片布局**:

```
┌─────────────────────────────┐
│ ○ Task Title                │
│ 🔍 Explorer                 │  ← 新增specialization徽章
│ 3 criteria • 2m ago         │
│ Result summary...           │
└─────────────────────────────┘
```

### 3. ui/src/ui/components/acceptance-panel.ts

**添加confidence分数显示**:

- 每个verdict显示置信度百分比
- 高置信度 (≥70%): 绿色背景
- 低置信度 (<70%): 黄色背景

**添加详细问题列表**:

- 显示每个issue的严重程度 (critical/major/minor)
- 显示每个issue的置信度
- 显示问题描述和文件位置
- 不同严重程度有不同的颜色边框

**验收结果布局**:

```
┌─────────────────────────────────────────┐
│ ✓ overall  85%  ← 置信度分数            │
│   Reasoning: All tests passed           │
│   Issues:                               │
│   ├─ [major] 75% Missing error handling │
│   │  src/api.ts:42                      │
│   └─ [minor] 60% Code could be simpler  │
│      src/utils.ts:15                    │
└─────────────────────────────────────────┘
```

### 4. ui/src/styles/orchestration.css

**新增样式类**:

**Specialization徽章样式**:

- `.orch-specialization-badge` - 基础徽章样式
- `.orch-specialization-badge--code-explorer` - Explorer颜色 (蓝色)
- `.orch-specialization-badge--code-architect` - Architect颜色 (紫色)
- `.orch-specialization-badge--code-implementer` - Implementer颜色 (绿色)
- `.orch-specialization-badge--code-reviewer` - Reviewer颜色 (橙色)
- `.orch-specialization-badge--researcher` - Researcher颜色 (粉色)
- `.orch-specialization-badge--generic` - Generic颜色 (灰色)

**Confidence分数样式**:

- `.orch-acceptance__verdict-confidence` - 置信度分数容器
- `.orch-acceptance__verdict-confidence--high` - 高置信度 (绿色)
- `.orch-acceptance__verdict-confidence--low` - 低置信度 (黄色)

**Issue列表样式**:

- `.orch-acceptance__verdict-issues` - 问题列表容器
- `.orch-acceptance__issue` - 单个问题
- `.orch-acceptance__issue--critical` - 严重问题 (红色边框)
- `.orch-acceptance__issue--major` - 主要问题 (黄色边框)
- `.orch-acceptance__issue--minor` - 次要问题 (蓝色边框)
- `.orch-acceptance__issue-severity` - 严重程度标签
- `.orch-acceptance__issue-confidence` - 问题置信度
- `.orch-acceptance__issue-description` - 问题描述
- `.orch-acceptance__issue-file` - 文件位置

**Dark主题支持**:

- 所有新样式都有对应的dark主题变体
- 使用半透明背景和调整后的颜色以适应暗色背景

## 视觉效果

### Specialization徽章颜色方案

| Specialization   | 图标 | 颜色           | 用途       |
| ---------------- | ---- | -------------- | ---------- |
| code-explorer    | 🔍   | 蓝色 (#1976d2) | 理解代码库 |
| code-architect   | 🏗️   | 紫色 (#7b1fa2) | 设计架构   |
| code-implementer | ⚙️   | 绿色 (#388e3c) | 编写代码   |
| code-reviewer    | 👁️   | 橙色 (#f57c00) | 审查质量   |
| researcher       | 📚   | 粉色 (#c2185b) | 收集信息   |
| generic          | 📋   | 灰色 (#757575) | 通用任务   |

### Confidence分数颜色

| 置信度范围 | 颜色 | 含义                    |
| ---------- | ---- | ----------------------- |
| ≥70%       | 绿色 | 高置信度 - 会触发修复   |
| <70%       | 黄色 | 低置信度 - 仅记录不阻塞 |

### Issue严重程度颜色

| 严重程度 | 边框颜色       | 背景色 |
| -------- | -------------- | ------ |
| critical | 红色 (#dc3545) | 浅红色 |
| major    | 黄色 (#ffc107) | 浅黄色 |
| minor    | 蓝色 (#17a2b8) | 浅蓝色 |

## 用户体验改进

### 1. 一目了然的Worker类型

- 用户可以立即看到每个subtask使用的worker类型
- 不同颜色的徽章帮助快速识别任务性质
- 图标提供视觉提示

### 2. 透明的置信度评分

- 用户可以看到每个acceptance verdict的置信度
- 高/低置信度用颜色区分
- 帮助理解为什么某些问题触发修复而其他不触发

### 3. 详细的问题追踪

- 每个issue显示严重程度和置信度
- 文件位置帮助快速定位问题
- 颜色编码帮助优先级排序

### 4. Dark主题友好

- 所有新元素都有dark主题变体
- 使用半透明颜色保持可读性
- 保持与现有UI的一致性

## 构建状态

✅ **所有构建通过** - 无编译错误

## 测试建议

### 1. 测试Specialization显示

```bash
# 提交一个任务，验证UI显示specialization徽章
orchestrator submit "Add OAuth authentication"
# 在UI中检查：
# - 每个task card显示specialization徽章
# - 不同类型有不同颜色
# - 图标正确显示
```

### 2. 测试Confidence显示

```bash
# 提交一个任务，验证UI显示confidence分数
orchestrator submit "Build a simple app"
# 在UI中检查：
# - Acceptance panel显示置信度百分比
# - 高置信度显示绿色
# - 低置信度显示黄色
```

### 3. 测试Issue列表

```bash
# 提交一个会产生issues的任务
orchestrator submit "Complex feature with potential issues"
# 在UI中检查：
# - Issues列表正确显示
# - 严重程度颜色正确
# - 文件位置可点击（如果实现）
```

### 4. 测试Dark主题

```bash
# 切换到dark主题
# 检查所有新元素在dark主题下的显示
# - 徽章颜色适配
# - 置信度分数可读
# - Issue列表对比度足够
```

## 未来增强（可选）

1. **可点击的文件位置**: 点击issue的文件位置直接跳转到代码
2. **Specialization过滤**: 在kanban board上按specialization过滤任务
3. **Confidence趋势**: 显示多次acceptance测试的confidence趋势图
4. **Issue统计**: 显示critical/major/minor问题的统计数字
5. **Workflow可视化**: 显示当前使用的workflow (feature-dev/bug-fix等)
6. **Phase进度**: 显示多阶段workflow的当前phase

## 总结

✅ **UI完全更新**

- 显示specialization徽章（6种类型，不同颜色）
- 显示confidence分数（高/低置信度区分）
- 显示详细issue列表（严重程度、置信度、位置）
- 支持dark主题
- 构建通过，无错误

✅ **用户体验提升**

- 一目了然的worker类型
- 透明的置信度评分
- 详细的问题追踪
- 视觉上吸引人且信息丰富
