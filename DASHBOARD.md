# Codex × Gemini AgentHub V0.3 - Web Dashboard Guide

The AgentHub Web Dashboard provides a real-time, lightweight web interface for project governance, human-AI team collaboration, and task visualization.

---

## 1. Accessing the Dashboard

When running AgentHub server:

```bash
npm start
# or
npx agenthub server --port 3000
```

The Web Dashboard is immediately available at:
- `http://localhost:3000/`
- `http://localhost:3000/dashboard`

The dashboard is self-contained (zero external CDN or bundle dependencies) and works seamlessly in isolated / air-gapped environments.

---

## 2. Dashboard Layout & Visual Zones

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ HEADER: Codex × Gemini AgentHub  [V0.3 Internal Alpha]      ● SSE Connected   │
├─────────────┬─────────────────────────────────────────────────────────────────┤
│ SIDEBAR:    │ TOP METRICS BAR:                                                │
│ Projects    │ [Project Progress: 62%] [Total: 8] [Running: 2] [Blocked: 1]    │
│             ├────────────────────────────────┬────────────────────────────────┤
│ • Proj Alpha│ LEFT PANEL: Tasks & Epics Tree │ RIGHT PANEL: Task Inspector    │
│ • Proj Beta │ 📁 EPIC-1: Auth Module (80%)   │ • Title / Description          │
│             │   ├── 🤖 TASK-1: Login (DONE)   │ • Owner: 🤖 codex (AGENT)      │
│             │   └── 👤 TASK-2: Signoff (DOING)│ • Reviewer: 🤖 gemini          │
│             │ 📌 Standalone Tasks            │ • Status: DOING | Progress: 30%│
│             │   └── 🤖 TASK-3: Schema (TODO)  │ • Next Action: ...             │
│             │                                │ • [Start] [Complete] [Resume]  │
│             ├────────────────────────────────┴────────────────────────────────┤
│             │ BOTTOM PANEL: Real-Time Activity Timeline (Live Event Stream)   │
│             │ 10:14:02 task.done (TASK-1) - 🤖 gemini                         │
│             │ 10:13:45 task.unblocked (TASK-2) - ⚙️ system                    │
└─────────────┴─────────────────────────────────────────────────────────────────┘
```

---

## 3. Key Capabilities & Interactions

### 3.1 Real-Time Server-Sent Events (SSE)
- When a project is selected, the frontend establishes an SSE stream to `/api/projects/:id/events/stream`.
- Visual connection status indicator displays green (`● SSE Connected`) or reconnecting (`○ Reconnecting...`).
- When backend events fire (`task.status_changed`, `task.blocked`, `task.unblocked`, `project.progress_updated`), the dashboard updates progress bars, task badges, and prepends event items without page reloads.

### 3.2 Visual Actor Badges
- Autonomous AI Agents: `🤖 codex`, `🤖 gemini` (rendered with indigo badge styling).
- Human Team Members: `👤 user`, `👤 zhangsan` (rendered with emerald green badge styling).
- System Automation: `⚙️ system`.

### 3.3 Human-in-the-Loop Controls
- **Human Task Start**: One-click `👤 Start Task (Human)` triggers `POST /api/tasks/:id/start`.
- **Human Task Complete**: One-click `👤 Complete Task (Human)` prompts for completion summary and triggers `POST /api/tasks/:id/complete`.
- **NEED_USER Decision**: When an AI task requests human guidance, a highlighted decision box appears with a decision textarea and `Submit Decision & Resume AI` button (`POST /api/tasks/:id/respond`).
- **Autonomous Task Run / Resume**: For AI tasks, triggers `POST /api/tasks/:id/run` or `resume`.
