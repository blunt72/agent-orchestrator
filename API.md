# REST API

Local Fastify API for projects, epics, tasks (including subtasks), human-in-the-loop operations and SSE streams. It binds to `127.0.0.1` by default and has **no authentication** — do not expose it to a network.

Start the server (install dependencies first; see [docs/install.md](docs/install.md)):

```bash
npm ci
npm run build
node dist/index.js server --port 3000 --host 127.0.0.1
```

Base URL: `http://127.0.0.1:3000/api`. Route definitions: `src/server/routes/projects.ts`, `src/server/routes/tasks.ts`.

---

## 1. Project Management

### Create Project
- **Endpoint**: `POST /projects`
- **Request Body**:
  ```json
  {
    "id": "PROJ-DEMO-001",
    "name": "Demo Test Automation Suite",
    "description": "Enterprise test automation platform",
    "workspace": "/path/to/repo"
  }
  ```
- **Response** (201 Created):
  ```json
  {
    "id": "PROJ-DEMO-001",
    "name": "Demo Test Automation Suite",
    "description": "Enterprise test automation platform",
    "workspace": "/path/to/repo",
    "status": "PLANNING",
    "progress": 0,
    "createdAt": "2026-10-02T08:00:00.000Z",
    "updatedAt": "2026-10-02T08:00:00.000Z"
  }
  ```

### List Projects
- **Endpoint**: `GET /projects`
- **Response** (200 OK): Array of `Project` objects.

### Get Project
- **Endpoint**: `GET /projects/:projectId`
- **Response** (200 OK): `Project` object.

### Get Project Tree
- **Endpoint**: `GET /projects/:projectId/tree`
- **Response** (200 OK):
  ```json
  {
    "project": { "id": "PROJ-DEMO-001", "name": "..." },
    "epics": [
      {
        "epic": { "id": "EPIC-001", "title": "Login Module" },
        "tasks": [
          {
            "task": { "id": "TASK-001", "title": "...", "status": "DONE" },
            "children": []
          }
        ]
      }
    ],
    "standaloneTasks": []
  }
  ```

### Get Project Progress
- **Endpoint**: `GET /projects/:projectId/progress`
- **Response** (200 OK):
  ```json
  {
    "projectId": "PROJ-DEMO-001",
    "progress": 62,
    "status": "ACTIVE"
  }
  ```

### Stream Project Events (SSE)
- **Endpoint**: `GET /projects/:projectId/events/stream`
- **Headers**: `Accept: text/event-stream`
- **Event format**:
  ```
  event: task.status_changed
  data: {"id":"EV-001","projectId":"PROJ-DEMO-001","type":"task.status_changed","actorId":"codex","actorType":"AGENT",...}
  ```

---

## 2. Epic Management

### Create Epic
- **Endpoint**: `POST /projects/:projectId/epics`
- **Request Body**:
  ```json
  {
    "id": "EPIC-001",
    "title": "Login Module Automation",
    "description": "Automate login and auth verification",
    "priority": "HIGH"
  }
  ```
- **Response** (201 Created): `Epic` object.

### List Epics
- **Endpoint**: `GET /projects/:projectId/epics`
- **Response** (200 OK): Array of `Epic` objects under the project.

### Get Epic
- **Endpoint**: `GET /epics/:epicId`
- **Response** (200 OK): `Epic` object.

---

## 3. Task Management & Operations

### Create Task
- **Endpoint**: `POST /tasks`
- **Request Body**:
  ```json
  {
    "projectId": "PROJ-DEMO-001",
    "epicId": "EPIC-001",
    "parentTaskId": "TASK-PARENT",
    "title": "Implement login validator",
    "description": "Add phone and email format validation",
    "workspace": "/path/to/repo",
    "ownerType": "AGENT",
    "ownerId": "codex",
    "reviewerId": "gemini",
    "dependsOn": ["TASK-001"],
    "estimatedWeight": 1,
    "maxRounds": 6,
    "testCommand": "npm test"
  }
  ```
- **Response** (201 Created): `Task` object.

### List Tasks
- **Endpoint**: `GET /tasks`
- **Query Parameters**:
  - `projectId`: filter by project ID
  - `epicId`: filter by epic ID
  - `status`: filter by task status (`TODO`, `BLOCKED`, `DOING`, `DONE`, etc.)

### Get Task
- **Endpoint**: `GET /tasks/:taskId`
- **Response** (200 OK): `Task` object.

### Run Autonomous Task (Agent)
- **Endpoint**: `POST /tasks/:taskId/run`
- Runs the task through worktree checkout, Codex development, independent test gate, and Gemini review.

### Cancel Task
- **Endpoint**: `POST /tasks/:taskId/cancel`
- Aborts ongoing execution and marks status `CANCELLED`.

### Resume Task
- **Endpoint**: `POST /tasks/:taskId/resume`
- Resumes execution from `NEED_USER`, `REWORK`, or `FAILED`.

### Assign Task (Actor Model)
- **Endpoint**: `POST /tasks/:taskId/assign`
- **Request Body**:
  ```json
  {
    "ownerId": "zhangsan",
    "ownerType": "HUMAN",
    "role": "Product Owner"
  }
  ```

### Start Human Task
- **Endpoint**: `POST /tasks/:taskId/start`
- **Request Body**: `{ "userId": "zhangsan" }`
- Transitions `TODO -> DOING`.

### Complete Human Task
- **Endpoint**: `POST /tasks/:taskId/complete`
- **Request Body**:
  ```json
  {
    "userId": "zhangsan",
    "summary": "Manual acceptance tests verified and passed."
  }
  ```
- Transitions `DOING -> DONE`, unblocks dependent tasks, recalculates progress.

### Respond to NEED_USER (Human Handoff)
- **Endpoint**: `POST /tasks/:taskId/respond`
- **Request Body**:
  ```json
  {
    "userId": "zhangsan",
    "message": "Use bcrypt with 12 rounds for password hashing."
  }
  ```
- Transitions `NEED_USER -> DOING`, appends decision to task requirements, and resumes AI execution.

### Block / Unblock Task
- **Block**: `POST /tasks/:taskId/block` (Body: `{ "reason": "Waiting on external API credentials" }`)
- **Unblock**: `POST /tasks/:taskId/unblock`

### Get Task Events
- **Endpoint**: `GET /tasks/:taskId/events`
- **Response** (200 OK): array of task audit events (`id`, `taskId`, `timestamp`, `type`, `actor`, `details`), e.g. `TASK_CREATED`, `WORKTREE_CREATED`, `TEST_PASSED`.

### Get Task Tree
- **Endpoint**: `GET /tasks/:taskId/tree`
- **Response** (200 OK): `{ "root": …, "parent": …, "task": …, "children": [] }`.

### Get Task Traceability
- **Endpoint**: `GET /tasks/:taskId/traceability`
- **Response** (200 OK): Full traceability record including root task, parent task, requirement source, status transitions, test gate history, and reviewer feedback.

## Atomic Task Claim

`POST /api/tasks/:taskId/claim`

```json
{ "ownerId": "gemini", "expectedOwnerId": "user" }
```

Claims a TODO task only when its current owner matches `expectedOwnerId`.
IDs must be 1-128 ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit. The new owner must differ from the old owner.
Success returns the task with a persisted `claim` receipt (ID, new/previous
owner and timestamp); status stays TODO and execution requires explicit dispatch.
Errors: 400 `INVALID_CLAIM`, 404 `TASK_NOT_FOUND`, or 409 `CLAIM_CONFLICT` /
`CLAIM_BUSY`.

Concurrent claims sharing the same local filesystem storage are serialized by
an exclusive per-task lock; competitors expecting the same old owner cannot
both succeed. This is not an execution lease, authentication boundary, or a
transaction across all lifecycle writes. `assignTask` remains an administrative
override and must not race claims. Existing scheduler/save operations do not
participate in this claim lock. Distributed/network filesystem behavior is not
guaranteed. A receipt records the claim at its timestamp, not ongoing ownership.

After a lost response, read the task before retrying: task persistence precedes
event append, so an event-write failure can leave a durable claim despite an
error response. A crashed process may leave a lock under `data/task-claims`;
there is deliberately no automatic expiry or takeover. An operator must verify
the holder is stopped and inspect current ownership before removing a stale lock.

For tasks carrying a claim receipt, dispatch selects the claimant as developer.
The claimant must be codex or gemini. An explicit
reviewerId of the other supported agent is required; missing, unsupported or same
reviewer values reject dispatch without changing the reviewer. Current ownerId
must match the developer during development, the reviewer in REVIEW/DONE, or
the human user in NEED_USER. The receipt retains the original developer through
these normal lifecycle handoffs. Unclaimed tasks
retain the legacy reviewer-derived developer selection. A reassigned task with
a historical claim that no longer matches its owner is rejected until its claim
configuration is explicitly reconciled; this release provides no reconciliation API.

## Local Task Execution Exclusion

`runTask` holds a separate per-task filesystem lock under `data/task-executions`
before reading state or starting agents, including time spent in its local queue.
Calls in the same Engine still share one dispatch promise. Competing Engines or
processes sharing the same local storage fail with `TASK_EXECUTION_BUSY`;
`POST /api/tasks/:taskId/run` maps this conflict to HTTP 409. Recovery scanning
skips busy tasks without replacing the live holder's state with an old snapshot.
The lock records task ID, PID and creation time and is released on normal return
or callback failure. It is deliberately retained after process death.

This is local execution exclusion, not a distributed lease or remote-call fencing.
No automatic stale-lock deletion is provided. Before manual recovery, inspect the
lock, confirm its holder has stopped, inspect the persisted task/checkpoint and
verify whether the original provider session is still active. A dead local PID
alone is not sufficient proof that a remote model call stopped. Only after those
checks may an operator remove the specific stale lock and explicitly retry.
If provider state is unknown, do not retry automatically.

`resumeTask` uses the same execution lock before reading or changing task state,
and keeps it through the resumed dispatch. Busy `/resume` returns HTTP 409 without
resume mutation. Resume restores REVIEW to the configured reviewer and preserves
the pending session checkpoint; development restores the claimant/legacy developer.
Invalid claimed reviewer configuration rejects before writes. Within one Engine,
a resume competing with an existing dispatch rejects rather than preparing twice.

Claim, administrative reassignment, human-response preparation, cancellation and arbitrary
store writes are not all protected by this execution lock. Concurrent lifecycle
mutations across processes remain outside the tested contract. Network filesystems
and different storage roots are not covered; a returned pending/error state does
not itself prove remote work has ended. Use supervised single-controller operation.

## Examples

Field names below come from the earlier V0.2 API description; check actual responses against `src/tasks/task.ts`.

### Example: completed task (`GET /api/tasks/:taskId`)
- **路径**: `GET /api/tasks/:id`
- **响应 (200 OK)**:
```json
{
  "id": "TASK-C7B840",
  "projectId": "proj-auth",
  "title": "完善输入校验并补充单测",
  "status": "DONE",
  "owner": "gemini",
  "reviewer": "gemini",
  "priority": "HIGH",
  "workspace": "/path/to/project",
  "branch": "agent/TASK-C7B840-完善输入校验并补充单测",
  "worktree": "/path/to/project/.agenthub/worktrees/TASK-C7B840",
  "currentRound": 3,
  "createdAt": "2026-10-01T15:44:25.535Z",
  "completedAt": "2026-10-01T15:47:00.052Z",
  "result": {
    "status": "PASS",
    "summary": "Task successfully developed, tested, reviewed, and approved.",
    "changedFiles": ["src/percentage.js", "tests/percentage.test.js"],
    "testStatus": "PASS",
    "testCommand": "npm test",
    "reviewStatus": "PASS",
    "rounds": 3,
    "branch": "agent/TASK-C7B840-完善输入校验并补充单测",
    "worktree": "/path/to/project/.agenthub/worktrees/TASK-C7B840"
  }
}
```

### Example: task events (`GET /api/tasks/:taskId/events`)
- **路径**: `GET /api/tasks/:id/events`
- **响应 (200 OK)**:
```json
[
  {
    "id": "evt-1790869465536-80730baf",
    "taskId": "TASK-C7B840",
    "timestamp": "2026-10-01T15:44:25.536Z",
    "type": "TASK_CREATED",
    "actor": "user",
    "details": { "projectId": "proj-auth", "title": "完善输入校验并补充单测" }
  },
  {
    "id": "evt-1790869465625-64d6dec3",
    "taskId": "TASK-C7B840",
    "timestamp": "2026-10-01T15:44:25.625Z",
    "type": "WORKTREE_CREATED",
    "actor": "system",
    "details": {
      "branch": "agent/TASK-C7B840-完善输入校验并补充单测",
      "worktree": "/path/to/project/.agenthub/worktrees/TASK-C7B840"
    }
  },
  {
    "id": "evt-1790869520540-8a5e194f",
    "taskId": "TASK-C7B840",
    "timestamp": "2026-10-01T15:45:20.540Z",
    "type": "TEST_PASSED",
    "actor": "system",
    "details": { "command": "npm test", "durationMs": 245 }
  }
]
```
