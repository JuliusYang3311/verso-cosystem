# Orchestrator Memory System - Technical Deep Dive

## 如何写入Memory？

Orchestrator的memory系统有**两种写入方式**：

### 1. 自动写入：Session History（会话历史）

**最主要的写入方式**，完全自动，无需手动操作。

```typescript
// 在 orchestrator-memory.ts 中初始化时
const memoryManager = await MemoryIndexManager.createIsolated({
  cfg,
  agentId,
  workspaceDir: memoryDir,
});

// MemoryIndexManager 的 sources 包含 "sessions"
// 这意味着所有的 chat 消息会自动被索引
```

**工作原理：**

1. Orchestrator Agent 和 Worker Agents 的所有对话都会被记录
2. MemoryIndexManager 自动监听 session 消息
3. 消息被自动切分、生成 embedding、存入 SQLite DB
4. 可以通过 hybrid search (vector + BM25) 检索

**示例：**

```
Orchestrator: "Create a REST API with Express"
Worker 1: "I've created the Express server with middleware..."
Worker 2: "I've implemented the authentication routes..."

→ 这些对话自动存入 memory
→ 后续可以搜索 "authentication" 找到相关上下文
```

### 2. 手动写入：MEMORY.md 文件

**可选方式**，由 Agent 主动创建文件。

**工作原理：**

```typescript
// orchestrator-memory.ts 中的 file watcher
// MemoryIndexManager 会监听 workspaceDir 中的 MEMORY.md 或 memory.md
if (this.sources.has("memory")) {
  this.ensureWatcher(); // 启动文件监听
}

// 当检测到文件变化时
watcher.on("change", async (filePath) => {
  await this.sync({ reason: "watch" });
});
```

**Agent 如何创建 MEMORY.md：**

Orchestrator Agent 或 Worker Agent 可以使用 file write tools：

```typescript
// Orchestrator Agent 在任务分解时可以写入
await writeFile({
  path: "MEMORY.md",
  content: `
# Orchestration Context

## Task: Build REST API

### Architecture Decisions
- Framework: Express.js
- Database: PostgreSQL
- Auth: JWT tokens

### Subtask Dependencies
- t1 (server setup) must complete before t2 (routes)
- t3 (auth) blocks t4 (protected routes)
  `,
});

// Worker Agent 在执行时可以追加
await appendFile({
  path: "MEMORY.md",
  content: `
### Worker 1 Progress
- Created Express server on port 3000
- Added middleware: cors, helmet, express.json
- Issue: Need to configure CORS origins
  `,
});
```

**自动 Ingestion：**

1. Agent 创建/修改 MEMORY.md
2. File watcher 检测到变化
3. 自动调用 `sync({ reason: "watch" })`
4. 文件内容被解析、切分、生成 embedding
5. 存入 SQLite DB 的 `memory` source

### 3. Memory 的存储结构

```
.verso-missions/<orchId>/memory/
├── memory.sqlite              # SQLite 数据库
│   ├── chunks 表              # 所有文本块
│   ├── embeddings 表          # 向量 embeddings
│   ├── latent_factors 表      # 语义聚类
│   └── metadata 表            # 元数据
└── MEMORY.md                  # 可选：Agent 创建的笔记
```

**SQLite Schema：**

```sql
-- chunks 表
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  source TEXT,           -- "sessions" 或 "memory"
  content TEXT,
  embedding BLOB,        -- 向量
  timestamp INTEGER,
  metadata JSON
);

-- latent_factors 表（语义聚类）
CREATE TABLE latent_factors (
  factor_id TEXT PRIMARY KEY,
  centroid BLOB,         -- 聚类中心向量
  chunk_ids JSON,        -- 属于这个聚类的 chunk IDs
  label TEXT
);
```

### 4. Memory 的检索方式

**Hybrid Search（混合搜索）：**

```typescript
// 在 Orchestrator Agent 或 Worker Agent 中
const results = await memoryManager.search({
  query: "authentication implementation",
  limit: 10,
  sources: ["sessions", "memory"], // 搜索两个来源
  mmr: true, // 使用 MMR 去重
});

// 返回结果
results.forEach((result) => {
  console.log(result.content); // 文本内容
  console.log(result.score); // 相似度分数
  console.log(result.source); // "sessions" 或 "memory"
});
```

**三层记忆检索：**

1. **L0 (Recent)**: 最近的消息（时间窗口）
2. **L1 (Important)**: 重要的上下文（高相似度）
3. **Chunks**: 所有历史记录（完整搜索）

### 5. 实际使用场景

#### 场景 1：Orchestrator 记录架构决策

```typescript
// Orchestrator Agent 在 create-plan 阶段
await writeFile({
  path: "MEMORY.md",
  content: `
# Project: Todo App

## Tech Stack
- Frontend: React + TypeScript
- Backend: Express + PostgreSQL
- Testing: Jest + Supertest

## Subtask Plan
1. t1: Setup Express server
2. t2: Create database schema
3. t3: Implement CRUD API
4. t4: Build React frontend
5. t5: Write integration tests
  `,
});

// 这些信息会被自动索引
// Worker 可以搜索 "database schema" 找到相关上下文
```

#### 场景 2：Worker 记录实现细节

```typescript
// Worker 1 完成任务后追加
await appendFile({
  path: "MEMORY.md",
  content: `
## Worker 1 - Express Server (t1)
- Port: 3000
- Middleware: cors, helmet, express.json, morgan
- Error handling: Global error middleware
- Database connection: pg pool with connection string from env
  `,
});

// Worker 2 可以搜索 "database connection" 了解如何连接
```

#### 场景 3：自动 Session History

```typescript
// 完全自动，无需手动操作

// Orchestrator 对话
Orchestrator: "Dispatch workers to execute subtasks"
System: "Worker 1 started on t1"
Worker 1: "I've created the Express server..."

// 这些对话自动存入 memory.sqlite
// 可以搜索 "Express server" 找到 Worker 1 的工作
```

### 6. Memory 的生命周期

```
1. Init (daemon-runner.ts)
   ↓
   创建 MemoryIndexManager.createIsolated()
   ↓
   设置 sources: ["sessions", "memory"]
   ↓
   启动 file watcher (监听 MEMORY.md)

2. Execution
   ↓
   Session messages → 自动索引到 "sessions" source
   ↓
   MEMORY.md 创建/修改 → 自动索引到 "memory" source
   ↓
   所有数据存入 memory.sqlite

3. Search
   ↓
   Orchestrator/Workers 调用 memoryManager.search()
   ↓
   Hybrid search: vector similarity + BM25 text search
   ↓
   返回最相关的上下文

4. Cleanup (daemon-runner.ts finally)
   ↓
   await memoryManager.close() → 关闭 DB 连接、停止 watcher
   ↓
   fs.rmSync(memoryDir) → 删除整个目录
   ↓
   所有数据被清理，不影响主 agent
```

### 7. 与主 Agent Memory 的隔离

**完全隔离，互不影响：**

```typescript
// 主 Agent 的 memory
~/.verso/emmory / main.sqlite;
~/.verso/emmory /
  // Orchestration 的 memory
  MEMORY.md.verso -
  missions / <orchId>/memory/emmory.sqlite.verso -
  missions / <orchId>/memory/EMMORY.md;

// 不同的 MemoryIndexManager 实例
// 不同的 SQLite DB
// 不同的 file watcher
// 完全独立的生命周期
```

### 8. 最佳实践

#### ✅ 推荐做法

1. **依赖自动 Session History**：大部分情况下足够了
2. **关键决策写入 MEMORY.md**：架构选择、依赖关系、重要约束
3. **Worker 记录实现细节**：API endpoints、配置、已知问题
4. **使用结构化格式**：Markdown headers 便于检索

#### ❌ 避免做法

1. **不要写入大量重复信息**：Session history 已经记录了
2. **不要写入临时调试信息**：会污染 memory
3. **不要依赖 MEMORY.md 传递实时状态**：用 orchestration state 代替

### 9. 调试 Memory

**查看 Memory 内容：**

```bash
# 查看 SQLite DB
sqlite3 .verso-missions/<orchId>/memory/memory.sqlite

# 查看所有 chunks
SELECT source, substr(content, 1, 100), timestamp FROM chunks;

# 查看 latent factors
SELECT factor_id, label, json_array_length(chunk_ids) as chunk_count FROM latent_factors;

# 查看 MEMORY.md
cat .verso-missions/<orchId>/memory/MEMORY.md
```

**检查 Memory 是否工作：**

```typescript
// 在 Orchestrator Agent 中测试
const results = await memoryManager.search({
  query: "test query",
  limit: 5,
});

console.log(`Found ${results.length} results`);
results.forEach((r) => console.log(r.content));
```

## 总结

Orchestrator 的 memory 写入有两种方式：

1. **自动写入（主要）**：所有 session 对话自动索引，无需手动操作
2. **手动写入（可选）**：Agent 创建 MEMORY.md 文件，file watcher 自动 ingest

两种方式的数据都存入同一个 SQLite DB，可以通过 hybrid search 统一检索。整个系统完全隔离，任务结束后自动清理。
