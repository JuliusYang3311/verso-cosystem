# Verso 推广文案模板

## Hacker News (Show HN)

**标题**：

```
Show HN: Verso – Multi-Agent Orchestration for Complex AI Tasks
```

**正文**：

```
Hi HN! I built Verso, a multi-agent orchestration system that can tackle complex projects by decomposing them into parallel subtasks.

Key features:
• True parallel execution - multiple AI agents work simultaneously
• Automatic fix cycles - failed tasks are retried up to 30 times
• Dual acceptance testing - mechanical (lint/test) + LLM evaluation
• Empty workspace design - builds projects from scratch

Example: "Create a blog app with React frontend, Express backend, and PostgreSQL"
→ Orchestrator creates 6 parallel subtasks
→ Workers execute simultaneously
→ Acceptance tests verify everything works
→ Complete app ready in ~10 minutes (vs 30-40 minutes sequential)

Built with TypeScript, uses Claude API, fully open source.

Demo video: [link]
GitHub: https://github.com/JuliusYang3311/verso-cosystem

Would love feedback on the architecture and use cases!
```

## Reddit r/MachineLearning

**标题**：

```
[P] Verso: Multi-Agent Orchestration System with Automatic Fix Cycles
```

**正文**：

```
I've been working on Verso, a multi-agent orchestration framework that addresses some challenges I faced with existing agent systems.

**Problem**: Most "multi-agent" systems execute tasks sequentially, not truly in parallel. When tasks fail, you have to manually retry or fix them.

**Solution**: Verso uses:
1. True parallel execution with isolated worker agents
2. Automatic fix cycles (up to 30 attempts)
3. Dual acceptance testing (mechanical + LLM-based)
4. Empty workspace design for building from scratch

**Architecture**:
- Orchestrator daemon decomposes tasks
- Worker pool executes subtasks in parallel
- In-memory sessions (no gateway pollution)
- Shared mission workspace with file-level isolation

**Performance**: 3-4x faster than sequential execution for complex projects.

**Tech stack**: TypeScript, Claude API, Node.js

GitHub: https://github.com/JuliusYang3311/verso-cosystem
Demo: [link]

Open to questions and feedback!
```

## Twitter/X Thread

**Tweet 1** (Hook):

```
I built a multi-agent orchestration system that can create a full-stack app in 10 minutes 🚀

Here's how it works 🧵
```

**Tweet 2** (Problem):

```
Most "multi-agent" systems are actually sequential:
Agent 1 → Agent 2 → Agent 3

This is slow and doesn't scale.

Verso does TRUE parallel execution:
Agent 1 ┐
Agent 2 ├→ All at once
Agent 3 ┘
```

**Tweet 3** (Solution):

```
How it works:

1️⃣ Orchestrator decomposes task into subtasks
2️⃣ Worker pool executes in parallel
3️⃣ Acceptance tests verify results
4️⃣ Auto-fix cycles if tests fail (max 30x)
5️⃣ Complete project ready to use
```

**Tweet 4** (Demo):

```
Example: "Create a blog app with React + Express + PostgreSQL"

→ 6 parallel subtasks
→ ~10 minutes total
→ Fully tested and working

Sequential would take 30-40 minutes.

3-4x speedup! ⚡
```

**Tweet 5** (Tech):

```
Built with:
• TypeScript
• Claude API
• In-memory agent sessions
• Empty workspace design

Open source on GitHub:
https://github.com/JuliusYang3311/verso-cosystem

⭐ if you find it useful!
```

**Tweet 6** (CTA):

```
Want to try it?

1. Clone the repo
2. Run `pnpm verso onboard`
3. Start building!

Demo video: [link]

Questions? Drop them below 👇
```

## Product Hunt

**Tagline**:

```
Multi-agent orchestration for complex AI tasks
```

**Description**:

```
Verso is a multi-agent orchestration system that tackles complex projects by decomposing them into parallel subtasks executed by autonomous AI agents.

Unlike traditional sequential agent systems, Verso enables true parallel execution with automatic retry logic and dual acceptance testing.

Perfect for:
• Building full-stack applications from scratch
• Complex research and analysis tasks
• Multi-component project generation
• Any task that benefits from parallel execution

Key features:
✅ True parallel execution
✅ Automatic fix cycles (up to 30 attempts)
✅ Dual acceptance testing
✅ Real-time orchestration UI
✅ Self-evolving optimization

Built with TypeScript and Claude API. Fully open source.
```

## LinkedIn Post

```
🚀 Excited to share Verso - a multi-agent orchestration system I've been building!

The challenge: Most AI agent systems execute tasks sequentially, which is slow and doesn't scale for complex projects.

The solution: Verso enables TRUE parallel execution with:
• Multiple AI agents working simultaneously
• Automatic retry logic (up to 30 fix cycles)
• Dual acceptance testing (mechanical + LLM)
• Real-time orchestration dashboard

Example use case: Creating a full-stack blog application
→ Traditional approach: 30-40 minutes sequential
→ With Verso: 10-12 minutes parallel
→ 3-4x speedup!

Built with TypeScript and Claude API. Open source on GitHub.

If you're working with AI agents or interested in multi-agent systems, I'd love to hear your thoughts!

#AI #MultiAgent #OpenSource #MachineLearning

[Link to GitHub]
[Link to demo video]
```

## Email to AI Newsletters

**Subject**: New open-source multi-agent orchestration system

**Body**:

```
Hi [Name],

I wanted to share Verso, an open-source multi-agent orchestration system I recently built.

What makes it different:
• True parallel execution (not sequential)
• Automatic fix cycles for failed tasks
• Dual acceptance testing
• 3-4x faster than sequential approaches

It's particularly useful for complex projects like building full-stack applications, where multiple components can be developed simultaneously.

Built with TypeScript and Claude API. Fully open source.

GitHub: https://github.com/JuliusYang3311/verso-cosystem
Demo: [link]

Would love to hear your thoughts if you cover AI agent systems!

Best,
[Your name]
```

---

## 使用建议

1. **不要同时发布所有渠道** - 间隔 1-2 天
2. **根据反馈调整文案** - 看哪些点最吸引人
3. **准备好快速回复** - 前 24 小时很关键
4. **真诚分享** - 不要过度营销
5. **展示实际价值** - 用具体例子而不是空话
