# Verso vs OpenClaw Telegram 组件差异分析

## 文件数量对比

- **Verso**: 46 个文件
- **OpenClaw**: 54 个文件
- **差异**: 缺少 13 个文件，多出 5 个文件

## 已移植的核心组件 ✅

### 1. 基础设施

- ✅ `button-types.ts` - 按钮类型定义
- ✅ `lane-delivery.ts` - 多通道传输系统
- ✅ `reasoning-lane-coordinator.ts` - 推理协调器
- ✅ `status-reaction-variants.ts` - 状态反应变体
- ✅ `draft-stream.ts` - 增强版（添加了 previewMode, previewRevision, clear, forceNewMessage）

### 2. 共享组件

- ✅ `channels/status-reactions.ts` - 状态反应控制器
- ✅ `media/local-roots.ts` - 媒体路径解析
- ✅ `shared/text/code-regions.ts` - 代码区域检测

## OpenClaw 独有但未移植的文件 ❌

### 高优先级（影响核心功能）

#### 1. **Delivery 系统模块化** (4 个文件)

```
delivery.replies.ts       - 回复特定逻辑
delivery.resolve-media.ts - 媒体解析和重试
delivery.send.ts          - 发送操作实现
reply-threading.ts        - 回复线程逻辑
```

**影响**：

- OpenClaw 的 delivery 系统更模块化、可测试
- Verso 的 `bot/delivery.ts` 是单体文件（约 400 行）
- OpenClaw 分成 4 个专门文件，职责更清晰

**是否需要**：中等优先级

- 当前 Verso 的单体实现已经足够
- 如果需要更好的可维护性，可以考虑重构

#### 2. **访问控制增强** (3 个文件)

```
dm-access.ts              - DM 访问控制
group-access.ts           - 群组访问控制（更细粒度）
group-config-helpers.ts   - 群组配置工具
```

**影响**：

- OpenClaw 有更细粒度的访问控制
- Verso 使用 `bot-access.ts` 提供基本访问控制

**是否需要**：低优先级

- Verso 的基本访问控制已经足够
- 除非需要更复杂的权限管理

#### 3. **论坛支持**

```
forum-service-message.ts  - 论坛服务消息处理
```

**影响**：

- OpenClaw 对 Telegram 论坛有专门支持
- Verso 通过 `threadSpec` 提供基本论坛支持

**是否需要**：低优先级

- 除非大量使用 Telegram 论坛功能

### 中优先级（改善用户体验）

#### 4. **原生命令菜单**

```
bot-native-command-menu.ts - 原生命令菜单管理
```

**影响**：

- OpenClaw 可以动态管理 Telegram 的 /commands 菜单
- Verso 使用 `bot-native-commands.ts` 处理命令，但不管理菜单

**是否需要**：中等优先级

- 改善用户体验
- 让用户更容易发现可用命令

#### 5. **错误处理增强**

```
sendchataction-401-backoff.ts - 401 错误退避逻辑
```

**影响**：

- OpenClaw 对 sendChatAction 401 错误有专门的退避策略
- Verso 使用通用的重试逻辑

**是否需要**：低优先级

- 除非频繁遇到 401 错误

### 低优先级（工具函数）

#### 6. **工具函数**

```
outbound-params.ts        - 出站参数工具
sequential-key.ts         - 顺序键生成
target-writeback.ts       - 目标回写逻辑
```

**影响**：

- 这些是辅助工具函数
- Verso 可能在其他地方实现了类似功能

**是否需要**：低优先级

- 按需添加

## Verso 独有的文件 ✅

```
bot-test-helpers.ts       - 测试辅助工具
download.ts               - 媒体下载工具
index.ts                  - 模块导出
pairing-store.ts          - 配对状态存储
webhook-set.ts            - Webhook 设置工具
```

**优势**：

- Verso 有更好的测试支持
- 有专门的媒体下载模块
- 有配对功能支持

## bot-message-dispatch.ts 详细对比

### 代码行数

- **Verso**: 398 行
- **OpenClaw**: 729 行
- **差异**: 331 行（OpenClaw 多 83%）

### 主要差异

#### OpenClaw 有但 Verso 没有的功能：

1. **多通道传输系统** ❌

   ```typescript
   // OpenClaw 创建 answer 和 reasoning 两个独立的 lanes
   const lanes: Record<LaneName, DraftLaneState> = {
     answer: createDraftLane("answer", canStreamAnswerDraft),
     reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
   };
   ```

   - Verso 只有单通道
   - 无法分离推理和答案流

2. **推理级别支持** ❌

   ```typescript
   // OpenClaw 支持 reasoningLevel: "off" | "on" | "stream"
   const resolvedReasoningLevel = resolveTelegramReasoningLevel({
     cfg,
     sessionKey: ctxPayload.SessionKey,
     agentId: route.agentId,
   });
   ```

   - Verso 没有集成推理级别配置

3. **状态反应集成** ❌

   ```typescript
   // OpenClaw 在 context 中有 statusReactionController
   const { statusReactionController } = context;
   ```

   - Verso 虽然移植了状态反应代码，但未集成到 dispatch

4. **预览归档和清理** ❌

   ```typescript
   // OpenClaw 管理归档的预览消息
   const archivedAnswerPreviews: ArchivedPreview[] = [];
   const archivedReasoningPreviewIds: number[] = [];
   ```

   - Verso 没有预览归档机制

5. **Lane 文本传递器** ❌

   ```typescript
   // OpenClaw 使用 createLaneTextDeliverer 处理多通道
   const deliverLaneText = createLaneTextDeliverer({
     lanes,
     archivedAnswerPreviews,
     // ...
   });
   ```

   - Verso 使用简单的单通道传递

6. **推理步骤状态** ❌

   ```typescript
   // OpenClaw 跟踪推理步骤状态
   const reasoningStepState = createTelegramReasoningStepState();
   ```

   - Verso 没有推理步骤跟踪

7. **媒体本地根目录** ❌

   ```typescript
   // OpenClaw 使用 getAgentScopedMediaLocalRoots
   const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
   ```

   - Verso 虽然移植了代码，但未在 dispatch 中使用

8. **Sticker 媒体修剪** ❌

   ```typescript
   // OpenClaw 有 pruneStickerMediaFromContext
   pruneStickerMediaFromContext(ctxPayload, { stickerMediaIncluded });
   ```

   - Verso 没有这个功能

9. **Draft 最小初始字符** ❌

   ```typescript
   // OpenClaw 设置最小字符数以改善推送通知体验
   const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS; // 30
   ```

   - Verso 没有这个优化

10. **HTML 渲染预览** ❌
    ```typescript
    // OpenClaw 使用 renderTelegramHtmlText 渲染预览
    const renderDraftPreview = (text: string) => ({
      text: renderTelegramHtmlText(text, { tableMode }),
      parseMode: "HTML" as const,
    });
    ```

    - Verso 没有预览渲染

#### Verso 有但 OpenClaw 没有的功能：

1. **EmbeddedBlockChunker** ✅

   ```typescript
   // Verso 使用 EmbeddedBlockChunker 进行块分割
   const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
   ```

   - OpenClaw 可能使用不同的分块策略

2. **Draft 分块配置** ✅
   ```typescript
   // Verso 有 resolveTelegramDraftStreamingChunking
   const draftChunking =
     draftStream && streamMode === "block"
       ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
       : undefined;
   ```

   - OpenClaw 可能内置在其他地方

## 功能对比矩阵

| 功能                           | Verso           | OpenClaw | 差距         |
| ------------------------------ | --------------- | -------- | ------------ |
| **核心传输**                   |
| 单通道传输                     | ✅              | ✅       | 相同         |
| 多通道传输（answer/reasoning） | ❌              | ✅       | **重要差距** |
| Draft streaming                | ✅              | ✅       | 相同         |
| Draft 错误降级                 | ✅              | ✅       | 相同         |
| **推理支持**                   |
| 推理级别配置                   | ❌              | ✅       | **重要差距** |
| 推理文本分离                   | ✅ (代码已移植) | ✅       | 未集成       |
| 推理步骤协调                   | ✅ (代码已移植) | ✅       | 未集成       |
| 推理流缓冲                     | ❌              | ✅       | **重要差距** |
| **用户体验**                   |
| 状态反应                       | ✅ (代码已移植) | ✅       | 未集成       |
| 预览管理                       | 基础            | 高级     | 差距         |
| 预览归档                       | ❌              | ✅       | 差距         |
| 最小初始字符优化               | ❌              | ✅       | 小差距       |
| **访问控制**                   |
| 基本访问控制                   | ✅              | ✅       | 相同         |
| 细粒度 DM 控制                 | ❌              | ✅       | 差距         |
| 细粒度群组控制                 | ❌              | ✅       | 差距         |
| **媒体处理**                   |
| 基本媒体处理                   | ✅              | ✅       | 相同         |
| Sticker 视觉支持               | ✅              | ✅       | 相同         |
| Sticker 媒体修剪               | ❌              | ✅       | 小差距       |
| 媒体本地根目录                 | ✅ (代码已移植) | ✅       | 未使用       |
| **其他**                       |
| 论坛支持                       | 基础            | 高级     | 差距         |
| 原生命令菜单                   | ❌              | ✅       | 差距         |
| 401 错误退避                   | ❌              | ✅       | 小差距       |

## 关键差距总结

### 🔴 重要差距（影响核心功能）

1. **多通道传输系统未集成**
   - 代码已移植（lane-delivery.ts）
   - 但 bot-message-dispatch.ts 未使用
   - 影响：无法分离推理和答案流

2. **推理支持未完全集成**
   - 代码已移植（reasoning-lane-coordinator.ts）
   - 但 bot-message-dispatch.ts 未使用
   - 影响：无法显示推理过程

3. **状态反应未集成**
   - 代码已移植（status-reactions.ts, status-reaction-variants.ts）
   - 但 bot-message-dispatch.ts 未使用
   - 影响：用户看不到实时状态（thinking, tool, done 等）

### 🟡 中等差距（影响用户体验）

4. **预览管理不够完善**
   - 缺少预览归档和清理
   - 可能导致孤立的预览消息

5. **访问控制不够细粒度**
   - 缺少 dm-access.ts 和 group-access.ts
   - 对于复杂权限需求可能不够

### 🟢 小差距（优化和工具）

6. **缺少一些优化**
   - 最小初始字符优化
   - 401 错误退避
   - 原生命令菜单

7. **缺少一些工具函数**
   - outbound-params.ts
   - sequential-key.ts
   - target-writeback.ts

## 下一步建议

### 立即行动（解决重要差距）

1. **集成多通道传输到 bot-message-dispatch.ts**
   - 使用已移植的 lane-delivery.ts
   - 创建 answer 和 reasoning lanes
   - 实现 lane 文本传递器

2. **集成推理支持**
   - 使用已移植的 reasoning-lane-coordinator.ts
   - 添加推理级别配置读取
   - 实现推理文本分离和缓冲

3. **集成状态反应**
   - 在 bot-message-context.ts 中创建 statusReactionController
   - 在 bot-message-dispatch.ts 中使用
   - 连接到 agent 生命周期事件

### 短期行动（改善用户体验）

4. **改进预览管理**
   - 实现预览归档
   - 添加预览清理逻辑

5. **添加原生命令菜单**
   - 移植 bot-native-command-menu.ts
   - 集成到 bot 初始化

### 长期考虑（可选优化）

6. **模块化 delivery 系统**
   - 如果需要更好的可维护性
   - 参考 OpenClaw 的 4 文件结构

7. **增强访问控制**
   - 如果需要更细粒度的权限管理
   - 移植 dm-access.ts 和 group-access.ts

## 估计工作量

- **集成多通道传输**: 4-6 小时
- **集成推理支持**: 2-3 小时
- **集成状态反应**: 2-3 小时
- **改进预览管理**: 2-3 小时
- **添加原生命令菜单**: 1-2 小时

**总计核心功能**: 约 11-17 小时

## 结论

Verso 已经成功移植了 OpenClaw 的核心组件代码（约 1,500+ 行），但**尚未集成到 bot-message-dispatch.ts 中**。这就像买了所有零件但还没组装起来。

**最关键的下一步**是将已移植的组件集成到 bot-message-dispatch.ts，这将立即解锁：

- 多通道传输（推理和答案分离）
- 实时状态反应（thinking, tool, done）
- 推理流支持

这些功能将显著改善 Telegram 用户体验，使其与 OpenClaw 的体验一致。
