# Codex × Gemini AgentHub V0.3 - Project Engine Architecture

## 1. Overview & System Mission

AgentHub V0.3 upgrades the platform from single isolated task execution to **Multi-Task Project Governance**:

```
Project ──► Epic ──► Task ──► SubTask ──► Human / AI Actor ──► Progress ──► Event ──► Traceability
```

It enables cross-functional collaboration between autonomous AI developers (Codex), autonomous AI reviewers (Gemini), and Human engineers / product owners within a structured, deterministic project management engine.

---

## 2. Core Architectural Pillars

### 2.1 Unified Actor & Ownership Model

Every task and project action is attributed to a first-class Actor entity:

```typescript
export type ActorType = "HUMAN" | "AGENT" | "SYSTEM";

export interface Actor {
  id: string;             // "codex", "gemini", "user", "zhangsan", etc.
  name: string;           // Display Name
  type: ActorType;
  role?: string;          // "Developer", "Reviewer", "Product Owner"
  avatar?: string;
}
```

Pre-configured system actors:
- `codex` (`AGENT`): Autonomous developer agent.
- `gemini` (`AGENT`): Autonomous reviewer agent.
- `user` (`HUMAN`): Default human operator / reviewer.

### 2.2 Project & Epic Lifecycle State Machines

- **Project Statuses**:
  - `PLANNING`: Initial state, configuring scope and epics.
  - `ACTIVE`: Active execution of tasks and sprints.
  - `PAUSED`: Temporarily paused by human decision.
  - `DONE`: All non-cancelled tasks completed (100% progress).
  - `CANCELLED`: Project abandoned or closed.

- **Epic Statuses**:
  - `TODO`: No tasks started yet.
  - `DOING`: At least one task is active (`DOING`, `TESTING`, `REVIEW`, `REWORK`, `NEED_USER`).
  - `DONE`: All tasks under this epic are completed.
  - `BLOCKED`: Explicitly blocked or waiting for external deliverables.

### 2.3 Task State Machine & Transitions

The V0.3 Task State Machine supports 10 states:

```
        ┌────────────────────────────────────────────────────────┐
        │                                                        │
        ▼                                                        │
     [TODO] ──────────► [BLOCKED] ──────────► [TODO]             │
        │                                       │                │
        │ (Start / Run)                         │ (Manual)       │
        ▼                                       ▼                │
     [DOING] ◄────────────────────────────── [REWORK]            │
        │                                       ▲                │
        │ (Agent Finishes Code)                 │                │
        ▼                                       │ (Test / Review │
     [TESTING] ─────────────────────────────────┤  Failed)       │
        │                                       │                │
        │ (Tests Pass)                          │                │
        ▼                                       │                │
     [REVIEW] ──────────────────────────────────┘                │
        │                                                        │
        │ (Review Passes)                                        │
        ▼                                                        │
     [DONE]                                                      │
                                                                 │
     [NEED_USER] ──(Human Decision / /respond)──► [DOING]        │
     [FAILED] / [CANCELLED] (Terminal states)                    │
```

Valid transitions:
- `TODO -> DOING`, `TODO -> BLOCKED`, `TODO -> CANCELLED`, `TODO -> FAILED`
- `BLOCKED -> TODO`, `BLOCKED -> CANCELLED`
- `DOING -> TESTING`, `DOING -> NEED_USER`, `DOING -> FAILED`, `DOING -> CANCELLED`, `DOING -> DONE` (Human direct complete)
- `TESTING -> REVIEW`, `TESTING -> REWORK`, `TESTING -> NEED_USER`, `TESTING -> FAILED`, `TESTING -> CANCELLED`
- `REVIEW -> DONE`, `REVIEW -> REWORK`, `REVIEW -> NEED_USER`, `REVIEW -> FAILED`, `REVIEW -> CANCELLED`
- `REWORK -> DOING`, `REWORK -> NEED_USER`, `REWORK -> FAILED`, `REWORK -> CANCELLED`
- `NEED_USER -> DOING`, `NEED_USER -> CANCELLED`, `NEED_USER -> FAILED`

---

## 3. Deterministic Progress Calculation

Per Section 十八 of the specification, project and epic progress is **strictly calculated mathematically** from task statuses and weights. Progress is **never hallucinated or estimated by LLMs**.

### 3.1 Status Weight Mapping

```typescript
export const STATUS_PROGRESS_MAP: Record<TaskStatus, number> = {
  TODO: 0,
  BLOCKED: 0,
  DOING: 30,
  TESTING: 60,
  REVIEW: 80,
  REWORK: 50,
  NEED_USER: 50,
  DONE: 100,
  FAILED: 0,
  CANCELLED: 0, // Excluded from calculation
};
```

### 3.2 Weighted Formula

For an active set of non-cancelled tasks $T$:

$$\text{Progress} = \frac{\sum_{t \in T} (\text{weight}(t) \times \text{progress}(t))}{\sum_{t \in T} \text{weight}(t)}$$

If all tasks are `CANCELLED` or no tasks exist, progress defaults to 0%. When all active tasks reach `DONE`, progress is 100%, and the parent Project/Epic automatically transitions to `DONE`.

---

## 4. Dependency Engine & Automatic Unblocking

Tasks can declare prerequisites via `dependsOn: [taskId1, taskId2, ...]`.

### 4.1 Blocker Resolution
- When a task is created or evaluated, `DependencyResolver.getActiveBlockers(task, allTasks)` checks whether prerequisite tasks have reached status `DONE`.
- Any prerequisite with status $\neq \text{DONE}$ is treated as an active blocker.
- If active blockers exist, the task automatically transitions to status `BLOCKED` with `blockedBy: [activeBlockerIds]`, and emits a `TASK_BLOCKED` event.

### 4.2 Cycle Detection
`DependencyResolver.detectCycle(tasks)` builds an adjacency graph and performs topological DFS to ensure DAG (Directed Acyclic Graph) invariants before task creation or dependency modification.

### 4.3 Automatic Unblocking Cascade
When a task completes (`DONE`):
1. `engine.completeHumanTask` or `TaskRunner` completion triggers `unblockDependentTasks(completedTaskId, projectId)`.
2. The dependency resolver identifies all tasks where `completedTaskId` was the last remaining blocker.
3. Those tasks transition automatically `BLOCKED -> TODO`, clearing `blockedBy`, updating `nextAction`, and emitting `TASK_UNBLOCKED` and `task.unblocked` SSE events.

---

## 5. Human-in-the-Loop & Handoff Operations

### 5.1 Human-Owned Tasks
Tasks with `ownerType: "HUMAN"`:
- `engine.startHumanTask(taskId, userId)`: Transitions `TODO -> DOING`, sets `startedAt`, updates `nextAction: "等待人类成员处理并标记完成"`.
- `engine.completeHumanTask(taskId, userId, summary)`: Transitions `DOING -> DONE`, records human signoff result, unblocks dependent tasks, and recalculates project progress.

### 5.2 AI NEED_USER Handoff & Human Decision
When an AI task hits an ambiguity, environmental barrier, or loop limit:
- Status transitions to `NEED_USER`.
- `nextAction: "等待人类成员输入决策以恢复执行"`.
- Human operator submits guidance via `POST /api/tasks/:id/respond` (`message`, `userId`).
- Engine appends `[Human Decision / Response by ${userId}]: ${message}` to task requirement description, transitions `NEED_USER -> DOING`, reassigns to `codex`, and resumes AI autonomous execution.

---

## 6. Concurrency Control Queue

To prevent system resource exhaustion and git contention:
- Engine enforces `maxConcurrentTasks` (default: 2).
- When more tasks are triggered simultaneously via `runTask(taskId)`, additional tasks enter an asynchronous queue:
  ```typescript
  if (this.runningTaskCount >= this.maxConcurrentTasks) {
    this.taskQueue.push(async () => { ... });
  }
  ```
- As running tasks complete, the queue drains automatically in FIFO order.

---

## 7. Real-Time SSE Event Dispatcher

Every state transition and project milestone emits structured events to connected clients:
- Clients connect via `GET /api/projects/:id/events/stream`.
- Server maintains event subscribers per project ID.
- Events stream in real-time (`task.created`, `task.started`, `task.done`, `task.blocked`, `task.unblocked`, `project.progress_updated`).
- Real-time client listeners update progress metrics, hierarchy trees, and the activity timeline without polling.
