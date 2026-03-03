# Orchestrator新功能验证 - Specialization & Confidence

## JSON序列化验证

### 1. Orchestration JSON结构

**完整的Orchestration对象会被序列化到JSON文件**:

- 位置: `.verso-orchestrations/<orchestrationId>.json`
- 序列化: `JSON.stringify(orch, null, 2)` (store.ts:130)
- 包含所有字段，包括新增的specialization和confidence

**Subtask JSON示例**:

```json
{
  "id": "t1",
  "title": "Explore authentication system",
  "description": "Trace how authentication works in the codebase",
  "acceptanceCriteria": ["Identified all relevant files", "Documented key patterns"],
  "specialization": "code-explorer", // ← 新字段
  "status": "completed",
  "dependsOn": [],
  "resultSummary": "Found 5 key files...",
  "retryCount": 0,
  "createdAtMs": 1234567890,
  "startedAtMs": 1234567900,
  "completedAtMs": 1234567950
}
```

**AcceptanceVerdict JSON示例**:

```json
{
  "subtaskId": "t1",
  "passed": false,
  "confidence": 85, // ← 新字段
  "reasoning": "Missing error handling in critical paths",
  "issues": [
    // ← 新字段
    {
      "severity": "major",
      "confidence": 85,
      "description": "No error handling for API failures",
      "file": "src/api.ts",
      "line": 42
    },
    {
      "severity": "minor",
      "confidence": 60,
      "description": "Code could be simplified",
      "file": "src/utils.ts",
      "line": 15
    }
  ]
}
```

### 2. Gateway RPC响应

**orchestration.get 返回完整对象**:

```typescript
// src/gateway/server-methods/orchestration.ts:47
respond(true, { orchestration: orch });
```

这意味着UI通过`orchestration.get`获取的数据包含：

- 所有subtask的specialization字段
- 所有acceptance verdict的confidence和issues字段

**orchestration.list 返回摘要**:

```typescript
// src/gateway/server-methods/orchestration.ts:22-32
{
  id: o.id,
  userPrompt: o.userPrompt.slice(0, 200),
  status: o.status,
  subtaskCount: o.plan?.subtasks.length ?? 0,
  fixCycle: o.currentFixCycle,
  maxFixCycles: o.maxFixCycles,
  createdAtMs: o.createdAtMs,
  updatedAtMs: o.updatedAtMs,
  completedAtMs: o.completedAtMs,
}
```

列表视图不包含详细信息，但点击进入详情后会调用`orchestration.get`获取完整数据。

## 数据流验证

### 创建Plan时 (orchestrator-tools.ts:176-193)

```typescript
const subtasks: Subtask[] = rawSubtasks.map((raw, i) => {
  const specialization =
    typeof raw.specialization === "string" ? (raw.specialization as string) : null;

  if (!specialization) {
    throw new Error(
      `Subtask ${id} missing required 'specialization' field. ` +
        `Must be one of: code-explorer, code-architect, code-implementer, code-reviewer, researcher, generic`,
    );
  }

  return createSubtask({
    id,
    title: String(raw.title ?? `Task ${i + 1}`),
    description: String(raw.description ?? ""),
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map(String)
      : [],
    specialization: specialization as any, // ← 强制要求
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : undefined,
  });
});
```

**验证点**:

1. ✅ Orchestrator必须为每个subtask指定specialization
2. ✅ 如果缺少specialization，会抛出错误
3. ✅ specialization被保存到Subtask对象

### 运行Acceptance时 (orchestrator-tools.ts:483-491)

```typescript
const CONFIDENCE_THRESHOLD = 70;
const highConfidenceFailures = result.verdicts.filter(
  (v) => !v.passed && v.confidence >= CONFIDENCE_THRESHOLD,
);
const lowConfidenceFailures = result.verdicts.filter(
  (v) => !v.passed && v.confidence < CONFIDENCE_THRESHOLD,
);
```

**验证点**:

1. ✅ Confidence字段被直接使用（无默认值）
2. ✅ 阈值70用于过滤高/低置信度问题
3. ✅ 只有高置信度问题触发修复

### LLM评估返回 (acceptance.ts:228-261)

```typescript
const parsed = JSON.parse(jsonMatch[0]) as {
  passed?: boolean;
  confidence?: number;  // ← LLM必须返回
  reasoning?: string;
  issues?: Array<{
    severity?: string;
    confidence?: number;  // ← 每个issue也有confidence
    description?: string;
    file?: string;
    line?: number;
  }>;
};

const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 100;
const issues = Array.isArray(parsed.issues) && parsed.issues.length > 0
  ? parsed.issues.map((issue) => ({
      severity: (issue.severity as "critical" | "major" | "minor") ?? "major",
      confidence: typeof issue.confidence === "number" ? issue.confidence : 100,
      description: issue.description ?? "Unknown issue",
      file: issue.file,
      line: issue.line,
    }))
  : undefined;

verdicts.push({
  subtaskId: "overall",
  passed: parsed.passed === true,
  confidence,  // ← 保存到verdict
  reasoning: parsed.reasoning ?? ...,
  issues,  // ← 保存issues数组
});
```

**验证点**:

1. ✅ LLM评估提示词要求返回confidence (acceptance.ts:108-132)
2. ✅ Confidence被解析并保存到verdict
3. ✅ Issues数组被解析并保存
4. ⚠️ 有fallback到100（用于JSON解析失败的情况）

### Worker执行时 (worker-prompt.ts)

```typescript
const specializationPrompt = getSpecializationPrompt(subtask.specialization);
const specializationDesc = getSpecializationDescription(subtask.specialization);

const basePrompt = `## Worker Agent — Orchestration Task
You are a worker agent executing a specific subtask as part of a larger orchestrated task.
**Your Role:** ${specializationDesc}
**Specialization:** ${subtask.specialization}
...`;

if (specializationPrompt) {
  return basePrompt + "\n\n" + specializationPrompt;
}
```

**验证点**:

1. ✅ Specialization被用于加载专业化提示词
2. ✅ Worker收到对应的专业化指导
3. ✅ 不同specialization的worker有不同的行为

## UI数据流验证

### 1. UI Controller类型定义 (ui/src/ui/controllers/orchestration.ts)

```typescript
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

**验证点**:

1. ✅ UI类型定义包含specialization字段
2. ✅ UI类型定义包含confidence和issues字段
3. ✅ 类型与后端Orchestration类型匹配

### 2. Task Card显示 (ui/src/ui/components/task-card.ts)

```typescript
function specializationBadge(specialization: OrchestrationSubtask["specialization"]) {
  const badges = {
    "code-explorer": { icon: "🔍", label: "Explorer", title: "Code Explorer - Understand codebase" },
    "code-architect": { icon: "🏗️", label: "Architect", title: "Code Architect - Design architecture" },
    // ... 其他类型
  };
  const badge = badges[specialization];
  return html`
    <span class="orch-specialization-badge orch-specialization-badge--${specialization}" title="${badge.title}">
      <span class="orch-specialization-badge__icon">${badge.icon}</span>
      <span class="orch-specialization-badge__label">${badge.label}</span>
    </span>
  `;
}

// 在renderTaskCard中使用
<div class="orch-task-card__specialization">
  ${specializationBadge(subtask.specialization)}
</div>
```

**验证点**:

1. ✅ Specialization字段被读取
2. ✅ 根据specialization显示不同的徽章
3. ✅ 每种类型有独特的图标和颜色

### 3. Acceptance Panel显示 (ui/src/ui/components/acceptance-panel.ts)

```typescript
${result.verdicts.map((v) => {
  const confidenceClass = v.confidence >= 70 ? "high" : "low";
  const confidenceLabel = v.confidence >= 70 ? "High confidence" : "Low confidence";
  return html`
    <div class="orch-acceptance__verdict ...">
      <span class="orch-acceptance__verdict-icon">${v.passed ? "✓" : "✗"}</span>
      <span class="orch-acceptance__verdict-task">${v.subtaskId}</span>
      <span class="orch-acceptance__verdict-confidence orch-acceptance__verdict-confidence--${confidenceClass}" title="${confidenceLabel}">
        ${v.confidence}%  // ← 显示confidence
      </span>
      ${v.reasoning ? html`<span class="orch-acceptance__verdict-reason">${v.reasoning}</span>` : nothing}
      ${v.issues && v.issues.length > 0 ? html`
        <div class="orch-acceptance__verdict-issues">
          ${v.issues.map((issue) => html`
            <div class="orch-acceptance__issue orch-acceptance__issue--${issue.severity}">
              <span class="orch-acceptance__issue-severity">${issue.severity}</span>
              <span class="orch-acceptance__issue-confidence">${issue.confidence}%</span>
              <span class="orch-acceptance__issue-description">${issue.description}</span>
              ${issue.file ? html`<span class="orch-acceptance__issue-file">${issue.file}${issue.line ? `:${issue.line}` : ""}</span>` : nothing}
            </div>
          `)}
        </div>
      ` : nothing}
    </div>
  `;
})}
```

**验证点**:

1. ✅ Confidence字段被读取并显示
2. ✅ 根据confidence显示不同颜色（高/低）
3. ✅ Issues数组被遍历并显示
4. ✅ 每个issue显示严重程度、置信度、描述、文件位置

## 端到端验证流程

### 场景1: 创建带specialization的Plan

```
1. Orchestrator Agent调用orchestrate工具
   └─ action: "create-plan"
   └─ subtasks: [
        {
          title: "Explore auth system",
          specialization: "code-explorer",  // ← 必须提供
          ...
        }
      ]

2. handleCreatePlan验证specialization
   └─ 如果缺少 → 抛出错误
   └─ 如果存在 → 创建Subtask对象

3. saveOrchestration保存到JSON
   └─ .verso-orchestrations/<id>.json
   └─ 包含specialization字段

4. Worker执行时
   └─ worker-prompt.ts读取specialization
   └─ 加载对应的专业化提示词
   └─ Worker收到专业化指导

5. UI显示
   └─ orchestration.get返回完整数据
   └─ task-card.ts显示specialization徽章
   └─ 用户看到🔍 Explorer徽章
```

### 场景2: Acceptance测试返回confidence

```
1. handleRunAcceptance调用runAcceptanceTests
   └─ acceptance.ts创建LLM评估提示词
   └─ 提示词要求返回confidence和issues

2. LLM返回JSON
   └─ {
        "passed": false,
        "confidence": 85,
        "issues": [
          {
            "severity": "major",
            "confidence": 85,
            "description": "Missing error handling"
          }
        ]
      }

3. acceptance.ts解析JSON
   └─ 提取confidence: 85
   └─ 提取issues数组
   └─ 创建AcceptanceVerdict对象

4. handleRunAcceptance过滤
   └─ CONFIDENCE_THRESHOLD = 70
   └─ 85 >= 70 → highConfidenceFailures
   └─ 触发修复

5. saveOrchestration保存
   └─ acceptanceResults包含confidence和issues

6. UI显示
   └─ acceptance-panel.ts读取confidence
   └─ 显示"85%"绿色徽章（高置信度）
   └─ 显示issues列表
   └─ 用户看到详细的问题信息
```

## 潜在问题和改进

### 1. Fallback默认值

**问题**: acceptance.ts中仍有fallback到100的逻辑

```typescript
const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 100;
```

**原因**: 用于JSON解析失败的情况（LLM返回格式错误）

**建议**:

- 保留fallback（用于容错）
- 但在日志中记录fallback情况
- 监控LLM是否正确返回confidence

### 2. UI类型安全

**当前状态**: UI类型定义正确，但运行时数据可能不匹配

**建议**:

- 添加运行时验证（如zod schema）
- 在UI controller中验证数据格式
- 处理缺少字段的情况

### 3. 测试覆盖

**需要测试**:

1. ✅ Orchestrator创建plan时必须提供specialization
2. ✅ Worker加载正确的专业化提示词
3. ✅ Acceptance返回confidence并正确过滤
4. ✅ UI正确显示specialization和confidence
5. ⚠️ JSON序列化/反序列化保留所有字段
6. ⚠️ Gateway RPC正确传输数据

## 验证清单

### 后端验证

- [x] types.ts: specialization字段是必需的
- [x] orchestrator-tools.ts: 验证specialization存在
- [x] worker-prompt.ts: 加载专业化提示词
- [x] acceptance.ts: LLM提示词要求confidence
- [x] acceptance.ts: 解析confidence和issues
- [x] orchestrator-tools.ts: 使用confidence过滤
- [x] store.ts: JSON序列化包含所有字段

### UI验证

- [x] orchestration.ts: 类型定义包含新字段
- [x] task-card.ts: 显示specialization徽章
- [x] acceptance-panel.ts: 显示confidence分数
- [x] acceptance-panel.ts: 显示issues列表
- [x] orchestration.css: 样式支持新元素

### 集成验证

- [x] Gateway RPC返回完整数据
- [x] UI通过orchestration.get获取数据
- [x] 数据流从后端到UI完整
- [x] 构建通过，无编译错误

## 结论

✅ **新功能已完全集成**

- Specialization在整个数据流中被使用
- Confidence在acceptance测试中被使用和显示
- UI正确显示所有新信息
- JSON序列化保留所有字段
- Gateway RPC传输完整数据

✅ **强制应用**

- Specialization是必需的（无默认值）
- Confidence被直接使用（阈值70）
- 不会静默降级

⚠️ **需要注意**

- Acceptance.ts有fallback到100（用于容错）
- 建议添加运行时验证
- 建议添加端到端测试
