export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentHub V0.3 - Project Governance & AI/Human Collaboration</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0284c7;
      --accent: #818cf8;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #a855f7;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }

    header {
      background-color: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      padding: 1rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .brand { display: flex; align-items: center; gap: 0.75rem; font-size: 1.25rem; font-weight: 700; color: var(--primary); }
    .badge { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .badge-alpha { background: #334155; color: #38bdf8; border: 1px solid #0284c7; }
    .badge-status { text-transform: uppercase; }
    .badge-agent { background: #1e1b4b; color: #a5b4fc; border: 1px solid #6366f1; }
    .badge-human { background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }

    /* Layout */
    .app-container { display: flex; flex: 1; overflow: hidden; height: calc(100vh - 65px); }
    
    /* Project Sidebar */
    .sidebar {
      width: 280px;
      background: #111827;
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-header { padding: 1rem; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; }
    .project-list { list-style: none; padding: 0.5rem; }
    .project-item {
      padding: 0.75rem;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 0.5rem;
      border: 1px solid transparent;
      transition: all 0.2s;
    }
    .project-item:hover { background: var(--card-bg); }
    .project-item.active { background: #1e293b; border-color: var(--primary); }
    .project-item h4 { font-size: 0.95rem; margin-bottom: 0.25rem; }
    .project-meta { font-size: 0.75rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; margin-top: 0.4rem; }

    /* Main Content */
    .main-view { flex: 1; display: flex; flex-direction: column; overflow-y: auto; padding: 1.5rem; gap: 1.5rem; }

    /* Metrics Bar */
    .metrics-bar { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; gap: 1rem; }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .metric-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.25rem; }
    .metric-val { font-size: 1.5rem; font-weight: 700; color: var(--text); }
    .progress-bar-container { background: #334155; border-radius: 9999px; height: 8px; overflow: hidden; margin-top: 0.5rem; }
    .progress-bar-fill { background: var(--primary); height: 100%; transition: width 0.3s; }

    /* Workspace 2-Column Split */
    .workspace-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; flex: 1; }

    /* Panel */
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel-header {
      padding: 0.75rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid var(--card-border);
      font-weight: 600;
      font-size: 0.95rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-body { padding: 1rem; flex: 1; overflow-y: auto; }

    /* Task Tree */
    .epic-block { margin-bottom: 1.25rem; }
    .epic-title { font-size: 0.85rem; font-weight: 700; color: var(--accent); margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .task-card {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .task-card:hover { border-color: var(--primary); }
    .task-card.selected { border-color: var(--primary); background: #172554; }
    .task-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem; }
    .task-card-title { font-size: 0.9rem; font-weight: 600; }
    .task-card-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; margin-top: 0.4rem; }

    /* Status Tags */
    .status-TODO { background: #334155; color: #cbd5e1; }
    .status-BLOCKED { background: #451a03; color: #f97316; border: 1px solid #ea580c; }
    .status-DOING { background: #1e3a8a; color: #93c5fd; }
    .status-TESTING { background: #3b0764; color: #d8b4fe; }
    .status-REVIEW { background: #14532d; color: #86efac; }
    .status-REWORK { background: #7c2d12; color: #fdba74; }
    .status-NEED_USER { background: #831843; color: #f472b6; border: 1px solid #ec4899; }
    .status-DONE { background: #064e3b; color: #34d399; }
    .status-FAILED { background: #7f1d1d; color: #f87171; }
    .status-CANCELLED { background: #1e293b; color: #64748b; }

    /* Task Detail / Inspector */
    .detail-row { margin-bottom: 0.75rem; }
    .detail-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.2rem; }
    .detail-val { font-size: 0.9rem; word-break: break-all; }
    .next-action-box { background: #172554; border-left: 3px solid var(--primary); padding: 0.75rem; border-radius: 4px; margin: 1rem 0; font-size: 0.85rem; }
    .user-decision-box { background: #4a044e; border: 1px solid #db2777; border-radius: 6px; padding: 1rem; margin-top: 1rem; }

    /* Button styles */
    .btn {
      padding: 0.4rem 0.8rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      transition: background 0.2s;
    }
    .btn-primary { background: var(--primary); color: #0f172a; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: var(--success); color: #0f172a; }
    .btn-danger { background: var(--danger); color: #ffffff; }
    .btn-outline { background: transparent; border: 1px solid var(--card-border); color: var(--text); }
    .btn-outline:hover { background: #334155; }
    .actions-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }

    /* Activity Timeline */
    .timeline-list { list-style: none; display: flex; flex-direction: column; gap: 0.5rem; }
    .timeline-item {
      padding: 0.5rem 0.75rem;
      background: #0f172a;
      border-left: 2px solid var(--accent);
      border-radius: 0 4px 4px 0;
      font-size: 0.8rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .timeline-type { font-weight: 600; color: var(--primary); }
    .timeline-actor { color: var(--text-muted); font-size: 0.75rem; }
    .timeline-time { color: #64748b; font-size: 0.7rem; }

    /* Responsive */
    @media (max-width: 1024px) {
      .workspace-grid { grid-template-columns: 1fr; }
      .metrics-bar { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>Codex × Gemini AgentHub</span>
      <span class="badge badge-alpha">V0.3 Internal Alpha</span>
    </div>
    <div style="display: flex; align-items: center; gap: 1rem;">
      <span id="sse-indicator" class="badge" style="background: #064e3b; color: #6ee7b7;">● SSE Connected</span>
      <span id="current-time" style="font-size: 0.8rem; color: var(--text-muted);"></span>
    </div>
  </header>

  <div class="app-container">
    <!-- Sidebar: Projects -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span style="font-size: 0.85rem; font-weight: 600; text-transform: uppercase;">Projects</span>
        <button class="btn btn-outline" onclick="promptCreateProject()">+ New</button>
      </div>
      <ul id="project-list" class="project-list">
        <li style="padding: 1rem; color: var(--text-muted); font-size: 0.85rem;">Loading projects...</li>
      </ul>
    </aside>

    <!-- Main Workspace -->
    <main class="main-view">
      <!-- Project Progress & Metrics -->
      <section class="metrics-bar">
        <div class="metric-card">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="metric-label">Project Progress</span>
            <span id="metric-progress-pct" class="metric-val" style="color: var(--primary);">0%</span>
          </div>
          <div class="progress-bar-container">
            <div id="metric-progress-bar" class="progress-bar-fill" style="width: 0%;"></div>
          </div>
        </div>
        <div class="metric-card">
          <span class="metric-label">Total Tasks</span>
          <span id="metric-total-tasks" class="metric-val">0</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Running Tasks</span>
          <span id="metric-running-tasks" class="metric-val" style="color: var(--primary);">0</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Blocked Tasks</span>
          <span id="metric-blocked-tasks" class="metric-val" style="color: var(--warning);">0</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Need User</span>
          <span id="metric-needuser-tasks" class="metric-val" style="color: var(--purple);">0</span>
        </div>
      </section>

      <!-- Task Tree & Inspector -->
      <div class="workspace-grid">
        <!-- Left: Task Hierarchy Tree -->
        <div class="panel">
          <div class="panel-header">
            <span>Project Tasks & Epics</span>
            <button class="btn btn-outline" onclick="promptCreateTask()">+ Add Task</button>
          </div>
          <div id="task-tree-container" class="panel-body">
            <div style="color: var(--text-muted); font-size: 0.85rem;">Select a project to load tasks.</div>
          </div>
        </div>

        <!-- Right: Task Inspector & Operations -->
        <div class="panel">
          <div class="panel-header">
            <span>Task Inspector & Controls</span>
            <span id="inspector-task-id" style="font-size: 0.8rem; color: var(--text-muted);">No task selected</span>
          </div>
          <div id="task-inspector-body" class="panel-body">
            <div style="color: var(--text-muted); font-size: 0.85rem; text-align: center; margin-top: 2rem;">
              Click a task on the left to inspect details and perform operations.
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom: Activity Timeline -->
      <div class="panel" style="max-height: 240px;">
        <div class="panel-header">
          <span>Project Activity Timeline (Live Stream)</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">Real-time events</span>
        </div>
        <div class="panel-body" style="padding: 0.5rem 1rem;">
          <ul id="timeline-list" class="timeline-list">
            <li style="color: var(--text-muted); font-size: 0.8rem;">No events logged yet.</li>
          </ul>
        </div>
      </div>
    </main>
  </div>

  <script>
    let activeProjectId = null;
    let selectedTaskId = null;
    let projects = [];
    let currentTasks = [];
    let eventSource = null;

    // Clock
    setInterval(() => {
      document.getElementById('current-time').textContent = new Date().toLocaleTimeString();
    }, 1000);

    // Initial Load
    window.addEventListener('DOMContentLoaded', async () => {
      await loadProjects();
    });

    async function loadProjects() {
      try {
        const res = await fetch('/api/projects');
        projects = await res.json();
        renderProjectList();
        if (projects.length > 0 && !activeProjectId) {
          selectProject(projects[0].id);
        }
      } catch (err) {
        console.error('Failed to load projects', err);
      }
    }

    function renderProjectList() {
      const container = document.getElementById('project-list');
      if (projects.length === 0) {
        container.innerHTML = '<li style="padding: 1rem; color: var(--text-muted); font-size: 0.85rem;">No projects found.</li>';
        return;
      }
      container.innerHTML = projects.map(p => \`
        <li class="project-item \${p.id === activeProjectId ? 'active' : ''}" onclick="selectProject('\${p.id}')">
          <h4>\${escapeHtml(p.name)}</h4>
          <div class="project-meta">
            <span class="badge badge-alpha">\${p.historicalClosureSummary ? '含历史结案 · 非正式验收完成' : p.status}</span>
            <span>\${Math.round(p.progress || 0)}%</span>
          </div>
        </li>
      \`).join('');
    }

    async function selectProject(projectId) {
      activeProjectId = projectId;
      renderProjectList();
      setupSSE(projectId);
      await refreshProjectView();
    }

    function setupSSE(projectId) {
      if (eventSource) {
        eventSource.close();
      }
      const indicator = document.getElementById('sse-indicator');
      try {
        eventSource = new EventSource(\`/api/projects/\${projectId}/events/stream\`);
        eventSource.onopen = () => {
          indicator.style.background = '#064e3b';
          indicator.style.color = '#6ee7b7';
          indicator.textContent = '● SSE Connected';
        };
        eventSource.onmessage = (e) => {
          handleIncomingEvent(JSON.parse(e.data));
        };
        // Listen to custom event types as well
        ['task.created', 'task.started', 'task.done', 'task.blocked', 'task.unblocked', 'task.status_changed', 'task.assigned', 'project.progress_updated'].forEach(evName => {
          eventSource.addEventListener(evName, (e) => {
            handleIncomingEvent(JSON.parse(e.data));
          });
        });
        eventSource.onerror = () => {
          indicator.style.background = '#451a03';
          indicator.style.color = '#f97316';
          indicator.textContent = '○ Reconnecting...';
        };
      } catch (e) {
        console.warn('SSE failed to setup', e);
      }
    }

    function handleIncomingEvent(event) {
      prependTimelineEvent(event);
      refreshProjectView();
    }

    async function refreshProjectView() {
      if (!activeProjectId) return;
      try {
        const [projRes, treeRes, evRes] = await Promise.all([
          fetch(\`/api/projects/\${activeProjectId}/progress\`).then(r => r.json()),
          fetch(\`/api/projects/\${activeProjectId}/tree\`).then(r => r.json()),
          fetch(\`/api/projects/\${activeProjectId}/events\`).then(r => r.json())
        ]);

        // Update progress & metrics
        const progressPct = Math.round(projRes.progress || 0);
        document.getElementById('metric-progress-pct').textContent = progressPct + '%';
        document.getElementById('metric-progress-bar').style.width = progressPct + '%';

        // Flatten tasks from tree
        currentTasks = [];
        function collectTasks(node) {
          if (!node) return;
          const t = node.task || node;
          currentTasks.push(t);
          if (node.children && Array.isArray(node.children)) {
            node.children.forEach(collectTasks);
          }
        }

        if (treeRes && treeRes.epics) {
          treeRes.epics.forEach(e => {
            if (e.tasks) e.tasks.forEach(collectTasks);
          });
        }
        if (treeRes && treeRes.standaloneTasks) {
          treeRes.standaloneTasks.forEach(collectTasks);
        }

        updateMetricsCounters(currentTasks);
        renderTaskTree(treeRes);
        renderTimeline(evRes);

        if (selectedTaskId) {
          const task = currentTasks.find(t => t.id === selectedTaskId);
          if (task) renderTaskInspector(task);
        }
      } catch (err) {
        console.error('Error refreshing project view', err);
      }
    }

    function updateMetricsCounters(tasks) {
      document.getElementById('metric-total-tasks').textContent = tasks.length;
      document.getElementById('metric-running-tasks').textContent = tasks.filter(t => ['DOING', 'TESTING', 'REVIEW'].includes(t.status)).length;
      document.getElementById('metric-blocked-tasks').textContent = tasks.filter(t => t.status === 'BLOCKED').length;
      document.getElementById('metric-needuser-tasks').textContent = tasks.filter(t => t.status === 'NEED_USER').length;
    }

    function renderTaskTree(tree) {
      const container = document.getElementById('task-tree-container');
      if (!tree || (!tree.epics?.length && !tree.standaloneTasks?.length)) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No tasks created for this project yet.</div>';
        return;
      }

      let html = '';
      if (tree.epics && tree.epics.length > 0) {
        tree.epics.forEach(epic => {
          html += \`
            <div class="epic-block">
              <div class="epic-title">
                <span>📁 \${escapeHtml(epic.title)}</span>
                <span class="badge badge-alpha">\${epic.historicalClosureSummary ? '含历史结案 · 非正式验收完成' : epic.status}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(\${Math.round(epic.progress || 0)}%)</span>
              </div>
              <div>
                \${renderTaskListHtml(epic.tasks || [])}
              </div>
            </div>
          \`;
        });
      }

      if (tree.standaloneTasks && tree.standaloneTasks.length > 0) {
        html += \`
          <div class="epic-block">
            <div class="epic-title">📌 Standalone Tasks</div>
            <div>
              \${renderTaskListHtml(tree.standaloneTasks)}
            </div>
          </div>
        \`;
      }

      container.innerHTML = html;
    }

    function renderTaskListHtml(nodes) {
      if (!nodes || nodes.length === 0) {
        return '<div style="color: var(--text-muted); font-size: 0.8rem; padding-left: 0.5rem;">No tasks under this section.</div>';
      }
      return nodes.map(node => {
        const t = node.task || node;
        const isAgent = t.ownerType === 'AGENT' || t.ownerId === 'codex' || t.ownerId === 'gemini';
        const ownerIcon = isAgent ? '🤖' : '👤';
        const ownerClass = isAgent ? 'badge-agent' : 'badge-human';
        return \`
          <div class="task-card \${t.id === selectedTaskId ? 'selected' : ''}" onclick="selectTask('\${t.id}')">
            <div class="task-card-header">
              <span class="task-card-title">\${escapeHtml(t.title)}</span>
              <span class="badge status-\${t.status}">\${t.orcaHistoricalCompletion?.kind === 'HISTORICAL_CLOSED_WITH_GAPS' ? '历史结案（保留缺口）' : t.status}</span>
            </div>
            <div class="task-card-footer">
              <span class="badge \${ownerClass}">\${ownerIcon} \${escapeHtml(t.ownerId || t.owner || 'unassigned')}</span>
              <span style="color: var(--text-muted);">\${Math.round(t.progress || 0)}%</span>
            </div>
          </div>
        \`;
      }).join('');
    }

    function selectTask(taskId) {
      selectedTaskId = taskId;
      const allCards = document.querySelectorAll('.task-card');
      allCards.forEach(c => c.classList.remove('selected'));
      const task = currentTasks.find(t => t.id === taskId);
      if (task) renderTaskInspector(task);
    }

    function renderTaskInspector(task) {
      document.getElementById('inspector-task-id').textContent = task.id;
      const container = document.getElementById('task-inspector-body');

      const isHuman = task.ownerType === 'HUMAN';
      const ownerIcon = isHuman ? '👤' : '🤖';
      const ownerBadgeClass = isHuman ? 'badge-human' : 'badge-agent';

      let actionsHtml = '';
      if (task.status === 'TODO' && isHuman) {
        actionsHtml += \`<button class="btn btn-success" onclick="startHumanTask('\${task.id}')">👤 Start Task (Human)</button>\`;
      }
      if (task.status === 'DOING' && isHuman) {
        actionsHtml += \`<button class="btn btn-success" onclick="completeHumanTask('\${task.id}')">👤 Complete Task (Human)</button>\`;
      }
      if (task.status === 'TODO' && !isHuman) {
        actionsHtml += \`<button class="btn btn-primary" onclick="runTask('\${task.id}')">🤖 Run Task (Agent)</button>\`;
      }
      if (task.status === 'REWORK' && !isHuman) {
        actionsHtml += \`<button class="btn btn-primary" onclick="resumeTask('\${task.id}')">🤖 Resume Task (Agent)</button>\`;
      }
      if (task.status !== 'DONE' && task.status !== 'CANCELLED') {
        actionsHtml += \`<button class="btn btn-danger" onclick="cancelTask('\${task.id}')">Cancel Task</button>\`;
      }

      let needUserBox = '';
      if (task.status === 'NEED_USER') {
        needUserBox = \`
          <div class="user-decision-box">
            <h4 style="color: #f472b6; margin-bottom: 0.5rem; font-size: 0.9rem;">Decision Required from Human</h4>
            <p style="font-size: 0.8rem; margin-bottom: 0.5rem; color: #fbcfe8;">The AI Agent has paused execution and requested human input or review.</p>
            <textarea id="need-user-input" style="width: 100%; height: 60px; background: #1e1b4b; border: 1px solid #db2777; color: white; border-radius: 4px; padding: 0.5rem; font-size: 0.85rem;" placeholder="Enter guidance or decision..."></textarea>
            <div style="margin-top: 0.5rem; text-align: right;">
              <button class="btn btn-primary" onclick="submitNeedUserResponse('\${task.id}')">Submit Decision & Resume AI</button>
            </div>
          </div>
        \`;
      }

      container.innerHTML = \`
        <div class="detail-row">
          <div class="detail-label">Title</div>
          <div class="detail-val" style="font-weight: 600; font-size: 1rem;">\${escapeHtml(task.title)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-label">Description</div>
          <div class="detail-val" style="white-space: pre-wrap; font-size: 0.85rem; color: var(--text-muted);">\${escapeHtml(task.description || '(none)')}</div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin: 0.75rem 0;">
          <div class="detail-row">
            <div class="detail-label">Owner</div>
            <div class="detail-val"><span class="badge \${ownerBadgeClass}">\${ownerIcon} \${task.ownerId || task.owner} (\${task.ownerType})</span></div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Reviewer</div>
            <div class="detail-val"><span class="badge badge-agent">🤖 \${task.reviewerId || 'gemini'}</span></div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Status</div>
            <div class="detail-val"><span class="badge status-\${task.status}">\${task.orcaHistoricalCompletion?.kind === 'HISTORICAL_CLOSED_WITH_GAPS' ? '历史结案（保留缺口）' : task.status}</span></div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Progress</div>
            <div class="detail-val" style="font-weight: 700; color: var(--primary);">\${Math.round(task.progress || 0)}%</div>
          </div>
        </div>
        \${task.orcaHistoricalCompletion?.kind === 'HISTORICAL_CLOSED_WITH_GAPS' ? \`
          <div class="next-action-box">
            <strong>历史结案，非正常正式验收通过。</strong><br>
            保留旧 CLI 审查与释放证据；未补造正式测试或审查记录，来源未认证。
            <div>缺口：\${escapeHtml((task.orcaHistoricalCompletion.approval?.acceptedGaps || []).join(', '))}</div>
          </div>
        \` : ''}
        \${task.nextAction ? \`
          <div class="next-action-box">
            <strong>Next Action:</strong> \${escapeHtml(task.nextAction)}
          </div>
        \` : ''}
        \${task.blockedBy && task.blockedBy.length > 0 ? \`
          <div style="background: #451a03; border-left: 3px solid #ea580c; padding: 0.5rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.8rem; color: #fdba74;">
            <strong>Blocked By:</strong> \${task.blockedBy.join(', ')}
          </div>
        \` : ''}
        \${needUserBox}
        <div class="actions-bar">
          \${actionsHtml}
        </div>
      \`;
    }

    async function startHumanTask(taskId) {
      try {
        await fetch(\`/api/tasks/\${taskId}/start\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'human-user' }) });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function completeHumanTask(taskId) {
      const summary = prompt('Enter task completion summary:', 'Completed manually by human team member.');
      if (summary === null) return;
      try {
        await fetch(\`/api/tasks/\${taskId}/complete\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'human-user', summary }) });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function submitNeedUserResponse(taskId) {
      const input = document.getElementById('need-user-input');
      const val = input ? input.value.trim() : '';
      if (!val) { alert('Please enter your decision or response.'); return; }
      try {
        await fetch(\`/api/tasks/\${taskId}/respond\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'human-user', message: val }) });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function runTask(taskId) {
      try {
        await fetch(\`/api/tasks/\${taskId}/run\`, { method: 'POST' });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function resumeTask(taskId) {
      try {
        await fetch(\`/api/tasks/\${taskId}/resume\`, { method: 'POST' });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function cancelTask(taskId) {
      if (!confirm('Are you sure you want to cancel this task?')) return;
      try {
        await fetch(\`/api/tasks/\${taskId}/cancel\`, { method: 'POST' });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function promptCreateProject() {
      const name = prompt('Project Name:');
      if (!name) return;
      const workspace = prompt('Project Workspace Path (or leave empty):', '');
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, workspace: workspace || undefined })
        });
        const proj = await res.json();
        await loadProjects();
        selectProject(proj.id);
      } catch (err) { alert('Failed: ' + err.message); }
    }

    async function promptCreateTask() {
      if (!activeProjectId) { alert('Please select a project first.'); return; }
      const title = prompt('Task Title:');
      if (!title) return;
      const isHuman = confirm('Is this a Human task? (Click OK for Human, Cancel for Codex AI)');
      const ownerType = isHuman ? 'HUMAN' : 'AGENT';
      const ownerId = isHuman ? 'user' : 'codex';
      try {
        await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: activeProjectId,
            title,
            description: title,
            ownerType,
            ownerId
          })
        });
        await refreshProjectView();
      } catch (err) { alert('Failed: ' + err.message); }
    }

    function renderTimeline(events) {
      const container = document.getElementById('timeline-list');
      if (!events || events.length === 0) {
        container.innerHTML = '<li style="color: var(--text-muted); font-size: 0.8rem;">No events logged yet.</li>';
        return;
      }
      container.innerHTML = events.slice(-30).reverse().map(e => createTimelineItemHtml(e)).join('');
    }

    function prependTimelineEvent(event) {
      const container = document.getElementById('timeline-list');
      const itemHtml = createTimelineItemHtml(event);
      container.insertAdjacentHTML('afterbegin', itemHtml);
    }

    function createTimelineItemHtml(e) {
      const actorIcon = e.actorType === 'AGENT' ? '🤖' : (e.actorType === 'HUMAN' ? '👤' : '⚙️');
      const timeStr = new Date(e.timestamp).toLocaleTimeString();
      return \`
        <li class="timeline-item">
          <div>
            <span class="timeline-type">\${escapeHtml(e.type)}</span>
            \${e.taskId ? \`<span style="color: var(--text-muted); margin-left: 0.5rem; font-size: 0.75rem;">(\${escapeHtml(e.taskId)})</span>\` : ''}
          </div>
          <div style="display: flex; gap: 1rem; align-items: center;">
            <span class="timeline-actor">\${actorIcon} \${escapeHtml(e.actorId)}</span>
            <span class="timeline-time">\${timeStr}</span>
          </div>
        </li>
      \`;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
