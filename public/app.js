/* global document, HTMLFormElement, HTMLSelectElement, URLSearchParams, navigator */

import { ApiError, createApiClient } from './api-client.js';

const api = createApiClient('/api/v1');
const root = document.querySelector('#app');
const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'completed', 'cancelled'];
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TRANSITIONS = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'completed', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};
const NAV = [
  ['dashboard', 'Dashboard', '⌂'],
  ['projects', 'Projects', '▦'],
  ['memories', 'Memories', '✦'],
  ['tasks', 'Tasks', '✓'],
  ['handoffs', 'Handoffs', '↗'],
  ['activity', 'Activity & Security', '◌'],
];

const state = {
  setupRequired: null,
  session: null,
  screen: 'dashboard',
  authMode: 'login',
  projects: [],
  projectId: null,
  loading: '',
  error: '',
  notice: '',
  warning: '',
  tasks: [],
  memories: [],
  handoffs: [],
  activity: [],
  context: null,
  devices: null,
  selectedMemory: null,
  memoryHistory: [],
  selectedHandoff: null,
  editingTaskId: null,
  taskStatus: '',
  taskPriority: '',
  memorySearch: null,
};

api.onUnauthorized(() => {
  clearSession();
  state.error = 'Your session expired. Sign in again.';
  render();
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-screen], [data-action], [data-project-id]');
  if (!target) return;
  if (target.dataset.screen) {
    state.screen = target.dataset.screen;
    clearMessages();
    if (state.screen === 'activity' && state.devices === null) void loadDevices();
    render();
    return;
  }
  if (target.dataset.projectId) {
    void selectProject(target.dataset.projectId);
    return;
  }
  const action = target.dataset.action;
  if (action === 'retry-init') void initialize();
  if (action === 'logout') void logout();
  if (action === 'refresh') void loadProjectData();
  if (action === 'new-task') {
    state.editingTaskId = 'new';
    state.screen = 'tasks';
    render();
  }
  if (action === 'cancel-task') {
    state.editingTaskId = null;
    render();
  }
  if (action === 'edit-task') void openTask(target.dataset.taskId);
  if (action === 'transition-task')
    void transitionTask(target.dataset.taskId, target.dataset.status);
  if (action === 'open-memory') void openMemory(target.dataset.memoryId);
  if (action === 'close-memory') {
    state.selectedMemory = null;
    state.memoryHistory = [];
    render();
  }
  if (action === 'open-handoff') void openHandoff(target.dataset.handoffId);
  if (action === 'close-handoff') {
    state.selectedHandoff = null;
    render();
  }
  if (action === 'clear-search') {
    state.memorySearch = null;
    render();
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.dataset.field === 'project') void selectProject(target.value);
  if (target.dataset.field === 'task-status') {
    state.taskStatus = target.value;
    render();
  }
  if (target.dataset.field === 'task-priority') {
    state.taskPriority = target.value;
    render();
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === 'auth-form') void submitAuth(form);
  if (form.id === 'project-form') void createProject(form);
  if (form.id === 'memory-search-form') void searchMemories(form);
  if (form.id === 'memory-create-form') void createMemory(form);
  if (form.id === 'memory-update-form') void updateMemory(form);
  if (form.id === 'task-form') void saveTask(form);
  if (form.id === 'handoff-form') void createHandoff(form);
});

function render() {
  if (!root) return;
  root.innerHTML = state.session ? renderWorkspace() : renderAuth();
}

function renderAuth() {
  const setup = state.setupRequired === true || state.authMode === 'setup';
  return `<main class="auth-page"><section class="auth-card" aria-labelledby="auth-title">
    <div class="brand-mark">✦</div><p class="eyebrow">LOCAL-FIRST MEMORY</p>
    <h1 id="auth-title">${setup ? 'Create your OmniMemory account' : 'Welcome back'}</h1>
    <p class="muted">${setup ? 'Create the owner account for this local workspace.' : 'Sign in to your authorized workspace.'}</p>
    ${state.error ? banner(state.error, 'error') : ''}${state.notice ? banner(state.notice, 'success') : ''}
    ${
      state.setupRequired === null
        ? state.error
          ? `<div class="error-block stack">
              <p class="muted">Could not connect to the local OmniMemory service.</p>
              <button class="button secondary small" type="button" data-action="retry-init">Retry connection</button>
              <p class="field-hint">Desktop diagnostics: <code>%APPDATA%\\OmniMemory\\logs\\desktop.log</code></p>
            </div>`
          : '<div class="loading-block">Checking local setup…</div>'
        : `<form id="auth-form" class="stack" novalidate>
      <label>Password<input name="password" type="password" required minlength="${setup ? 12 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}" aria-describedby="password-hint" /></label>
      ${setup ? '<p id="password-hint" class="field-hint">Use at least 12 characters. Your password is stored only as a secure hash.</p><label>Confirm password<input name="passwordConfirmation" type="password" required minlength="12" autocomplete="new-password" /></label>' : ''}
      <label>Device name<input name="deviceName" required maxlength="100" value="Browser" /></label>
      <label>Device type<input name="deviceType" required maxlength="50" value="browser" /></label>
      <button class="button primary" type="submit">${setup ? 'Create owner account' : 'Sign in'}</button>
    </form>`
    }
    <p class="auth-footnote">Bearer sessions stay in memory only and are cleared on logout or expiry.</p>
  </section></main>`;
}

function renderWorkspace() {
  const project = selectedProject();
  return `<div class="app-shell"><aside class="sidebar">${renderBrand()}
    <label class="project-picker">Project<select data-field="project" aria-label="Select project">
      <option value="">${state.projects.length ? 'Select a project' : 'No projects yet'}</option>
      ${state.projects.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.projectId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
    </select></label><nav class="sidebar-nav" aria-label="Primary navigation">${NAV.map(([id, label, icon]) => navItem(id, label, icon)).join('')}</nav>
    <div class="sidebar-footer"><span class="connection-dot"></span>Local API · loopback only</div></aside>
    <div class="workspace"><header class="topbar"><button class="mobile-menu-brand" data-screen="dashboard">✦ <span>OmniMemory</span></button>
      <div class="topbar-project">${escapeHtml(project?.name || 'Choose a project')}</div><div class="topbar-actions"><span class="identity-chip">${escapeHtml(state.session.deviceName)} · ${escapeHtml(state.session.role)}</span><button class="button ghost small" data-action="logout">Sign out</button></div></header>
      <main class="content">${state.error ? banner(state.error, 'error') : ''}${state.notice ? banner(state.notice, 'success') : ''}${state.warning ? banner(state.warning, 'warning') : ''}${state.loading ? '<div class="loading-strip" role="status">Loading latest workspace data…</div>' : ''}${renderScreen()}</main>
      <nav class="mobile-nav" aria-label="Mobile navigation">${NAV.map(([id, label, icon]) => `<button class="mobile-nav-item ${state.screen === id ? 'active' : ''}" data-screen="${id}"><span>${icon}</span><small>${escapeHtml(label.replace(' & Security', ''))}</small></button>`).join('')}</nav>
    </div></div>`;
}

function renderBrand() {
  return '<button class="brand" data-screen="dashboard"><span class="brand-symbol">✦</span><span><strong>OmniMemory</strong><small>authorized workspace</small></span></button>';
}

function navItem(id, label, icon) {
  return `<button class="nav-item ${state.screen === id ? 'active' : ''}" data-screen="${id}"><span class="nav-icon">${icon}</span><span>${escapeHtml(label)}</span></button>`;
}

function renderScreen() {
  if (state.screen === 'projects') return renderProjects();
  if (!state.projectId) return renderNoProject();
  if (state.screen === 'memories') return renderMemories();
  if (state.screen === 'tasks') return renderTasks();
  if (state.screen === 'handoffs') return renderHandoffs();
  if (state.screen === 'activity') return renderActivity();
  return renderDashboard();
}

function pageHeader(eyebrow, title, description, action = '') {
  return `<div class="page-header"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(description)}</p></div>${action}</div>`;
}

function renderDashboard() {
  const tasks = state.tasks.length ? state.tasks : state.context?.recentTasks || [];
  const memories = state.memories.length ? state.memories : state.context?.recentMemories || [];
  const handoffs = state.handoffs.length ? state.handoffs : state.context?.recentHandoffs || [];
  const counts = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  );
  return `${pageHeader('PROJECT OVERVIEW', 'Dashboard', 'A current view of this project using only records returned by the local API.', '<button class="button ghost" data-action="refresh">Refresh</button>')}
    <section class="metrics-grid"><div class="metric-card accent"><span>All tasks</span><strong>${tasks.length}</strong><small>${counts.in_progress || 0} in progress</small></div><div class="metric-card"><span>To do</span><strong>${counts.todo || 0}</strong><small>ready to start</small></div><div class="metric-card"><span>Blocked</span><strong>${counts.blocked || 0}</strong><small>needs attention</small></div><div class="metric-card"><span>Completed</span><strong>${counts.completed || 0}</strong><small>marked complete</small></div></section>
    <div class="dashboard-grid"><section class="panel span-two"><div class="panel-heading"><div><h2>Recent tasks</h2><p class="muted">Latest task records from this project.</p></div><button class="button text" data-screen="tasks">View tasks →</button></div>${tasks.length ? `<div class="record-list">${tasks.slice(0, 6).map(taskRow).join('')}</div>` : emptyState('No tasks yet', 'Create a task to start tracking work.')}</section>
    <section class="panel"><div class="panel-heading"><div><h2>Recent memories</h2><p class="muted">Durable project context.</p></div><button class="button text" data-screen="memories">View memories →</button></div>${memories.length ? `<div class="record-list">${memories.slice(0, 5).map(memoryRow).join('')}</div>` : emptyState('No memories yet', 'Record a fact, finding, or note.')}</section>
    <section class="panel"><div class="panel-heading"><div><h2>Recent handoffs</h2><p class="muted">Immutable transfer records.</p></div><button class="button text" data-screen="handoffs">View handoffs →</button></div>${handoffs.length ? `<div class="record-list">${handoffs.slice(0, 5).map(handoffRow).join('')}</div>` : emptyState('No handoffs yet', 'Record evidence-backed next steps when work moves agents.')}</section></div>`;
}

function renderProjects() {
  const canCreate = state.session.role === 'owner' || state.session.role === 'admin';
  return `${pageHeader('WORKSPACE', 'Projects', 'Choose a project to view its context, tasks, memories, and handoffs.')}
    <div class="project-layout"><section class="panel"><div class="panel-heading"><div><h2>Accessible projects</h2><p class="muted">Only projects returned by your session are shown.</p></div></div>
      ${state.projects.length ? `<div class="project-grid">${state.projects.map((project) => `<button class="project-card ${project.id === state.projectId ? 'selected' : ''}" data-project-id="${escapeHtml(project.id)}"><span class="project-avatar">${escapeHtml((project.name || '?').slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.description || 'No description')}</span><small>Updated ${formatDate(project.updatedAt)}</small></button>`).join('')}</div>` : emptyState('No accessible projects', 'Create a project or ask an administrator to grant access.')}
    </section>${canCreate ? `<section class="panel form-panel"><div class="panel-heading"><div><h2>Create project</h2><p class="muted">Projects are created through the existing API.</p></div></div><form id="project-form" class="stack"><label>Name<input name="name" required maxlength="200" /></label><label>Description<textarea name="description" rows="4" maxlength="2000"></textarea></label><button class="button primary" type="submit">Create project</button></form></section>` : ''}</div>`;
}

function renderNoProject() {
  return `<section class="empty-page"><div class="empty-icon">▦</div><h1>Select a project</h1><p class="muted">Choose a project from the sidebar to load its workspace.</p><button class="button primary" data-screen="projects">Browse projects</button></section>`;
}

function renderMemories() {
  const records = state.memorySearch || state.memories;
  return `${pageHeader('PROJECT MEMORY', 'Memories', 'Search and maintain durable context with provenance and version history.')}
    <div class="two-column-layout"><div class="stack"><section class="panel form-panel"><div class="panel-heading"><div><h2>Search memories</h2><p class="muted">Search is project-scoped by the backend.</p></div></div><form id="memory-search-form" class="inline-form"><label class="sr-only" for="memory-query">Search query</label><input id="memory-query" name="query" type="search" required maxlength="500" placeholder="Search title or content" /><button class="button secondary" type="submit">Search</button>${state.memorySearch ? '<button class="button ghost" type="button" data-action="clear-search">Clear</button>' : ''}</form></section>
      <section class="panel form-panel"><div class="panel-heading"><div><h2>Record a memory</h2><p class="muted">Content is untrusted text and is validated by the server.</p></div></div>${memoryForm('memory-create-form')}</section>
      <section class="panel"><div class="panel-heading"><div><h2>${state.memorySearch ? 'Search results' : 'Recent memories'}</h2><p class="muted">${records.length} record${records.length === 1 ? '' : 's'}</p></div></div>${records.length ? `<div class="memory-list">${records.map(memoryCard).join('')}</div>` : emptyState(state.memorySearch ? 'No matches' : 'No memories yet', state.memorySearch ? 'Try a broader query.' : 'Create the first memory for this project.')}</section></div>
      <aside>${state.selectedMemory ? memoryDetail() : '<section class="panel detail-placeholder"><div class="empty-icon">✦</div><h2>Select a memory</h2><p class="muted">Inspect provenance, revisions, and version-protected updates.</p></section>'}</aside></div>`;
}

function memoryForm(id) {
  return `<form id="${id}" class="stack"><label>Record type<select name="recordType"><option value="note">Note</option><option value="finding">Finding</option><option value="project_fact">Project fact</option><option value="constraint">Constraint</option><option value="requirement">Requirement</option></select></label><label>Title<input name="title" required maxlength="200" /></label><label>Content<textarea name="content" rows="6" required maxlength="100000"></textarea></label><div class="form-grid"><label>Source kind<select name="sourceKind">${memorySourceOptions()}</select></label><label>Verification<select name="verificationStatus">${verificationOptions()}</select></label></div><label>Source reference <span class="optional">optional</span><input name="sourceReference" maxlength="500" /></label><label>Verification method <span class="optional">optional</span><input name="verificationMethod" maxlength="500" /></label><button class="button primary" type="submit">Save memory</button></form>`;
}

function memoryDetail() {
  const memory = state.selectedMemory;
  return `<section class="panel form-panel"><div class="panel-heading"><div><h2>Memory details</h2><p class="muted">Version ${memory.version} · updated ${formatDate(memory.updatedAt)}</p></div><button class="button ghost small" data-action="close-memory">Close</button></div><div class="detail-meta"><span class="badge">${escapeHtml(memory.recordType)}</span><span class="badge ${verificationClass(memory.provenance?.verificationStatus)}">${escapeHtml(memory.provenance?.verificationStatus || 'unverified')}</span></div><form id="memory-update-form" class="stack"><input type="hidden" name="memoryId" value="${escapeHtml(memory.id)}" /><input type="hidden" name="expectedVersion" value="${memory.version}" /><label>Record type<select name="recordType">${memoryRecordOptions(memory.recordType)}</select></label><label>Title<input name="title" required maxlength="200" value="${escapeHtml(memory.title)}" /></label><label>Content<textarea name="content" rows="8" required maxlength="100000">${escapeHtml(memory.content)}</textarea></label><div class="form-grid"><label>Source kind<select name="sourceKind">${memorySourceOptions(memory.provenance?.sourceKind)}</select></label><label>Verification<select name="verificationStatus">${verificationOptions(memory.provenance?.verificationStatus)}</select></label></div><label>Change reason <span class="optional">optional</span><input name="changeReason" maxlength="500" /></label><button class="button primary" type="submit">Save new version</button></form><div class="provenance"><h3>Provenance</h3><p><strong>Source:</strong> ${escapeHtml(memory.provenance?.sourceKind || 'unknown')}</p><p><strong>Recorded:</strong> ${formatDate(memory.provenance?.recordedAt)}</p>${memory.provenance?.sourceReference ? `<p><strong>Reference:</strong> ${escapeHtml(memory.provenance.sourceReference)}</p>` : ''}</div><div class="history"><h3>Revision history</h3>${state.memoryHistory.length ? state.memoryHistory.map((item) => `<div class="history-item"><strong>Version ${item.version}</strong><span>${formatDate(item.createdAt)}</span><p>${escapeHtml(item.changeReason || item.title)}</p></div>`).join('') : '<p class="muted">No history returned.</p>'}</div></section>`;
}

function renderTasks() {
  const visible = state.tasks.filter(
    (task) =>
      (!state.taskStatus || task.status === state.taskStatus) &&
      (!state.taskPriority || task.priority === state.taskPriority),
  );
  const editing =
    state.editingTaskId && state.editingTaskId !== 'new'
      ? state.tasks.find((task) => task.id === state.editingTaskId)
      : null;
  return `${pageHeader('WORK TRACKING', 'Tasks', 'Track work with explicit statuses, priorities, evidence, and version protection.', '<button class="button primary" data-action="new-task">New task</button>')}
    <section class="filter-bar"><label>Status<select data-field="task-status"><option value="">All statuses</option>${TASK_STATUSES.map((item) => `<option value="${item}" ${state.taskStatus === item ? 'selected' : ''}>${escapeHtml(label(item))}</option>`).join('')}</select></label><label>Priority<select data-field="task-priority"><option value="">All priorities</option>${TASK_PRIORITIES.map((item) => `<option value="${item}" ${state.taskPriority === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label><span class="filter-count">${visible.length} shown · ${state.tasks.length} returned</span></section>
    ${state.editingTaskId ? `<section class="panel form-panel task-editor"><div class="panel-heading"><div><h2>${editing ? 'Edit task' : 'Create task'}</h2><p class="muted">${editing ? `Version ${editing.version}; stale edits are rejected by the backend.` : 'New tasks start in todo.'}</p></div><button class="button ghost small" data-action="cancel-task">Cancel</button></div>${taskForm(editing)}</section>` : ''}
    <section class="panel"><div class="panel-heading"><div><h2>Task list</h2><p class="muted">Only valid transitions are offered below each task.</p></div></div>${visible.length ? `<div class="task-list">${visible.map(taskCard).join('')}</div>` : emptyState('No matching tasks', 'Adjust the filters or create a task.')}</section>`;
}

function taskForm(task) {
  return `<form id="task-form" class="stack"><input type="hidden" name="taskId" value="${escapeHtml(task?.id || '')}" /><input type="hidden" name="expectedVersion" value="${task?.version || ''}" /><label>Title<input name="title" required maxlength="200" value="${escapeHtml(task?.title || '')}" /></label><label>Description<textarea name="description" rows="5" maxlength="10000">${escapeHtml(task?.description || '')}</textarea></label><div class="form-grid"><label>Priority<select name="priority">${TASK_PRIORITIES.map((item) => `<option value="${item}" ${(!task && item === 'normal') || task?.priority === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label><label>Due date <span class="optional">optional</span><input name="dueDate" type="date" value="${escapeHtml(task?.dueDate || '')}" /></label></div><label>Assigned device ID <span class="optional">optional</span><input name="assignedDeviceId" value="${escapeHtml(task?.assignedDeviceId || '')}" /></label><label>Linked memory IDs <span class="optional">one UUID per line</span><textarea name="linkedMemoryIds" rows="3">${escapeHtml((task?.linkedMemoryIds || []).join('\n'))}</textarea></label><label>Evidence references <span class="optional">one per line</span><textarea name="evidenceReferences" rows="3">${escapeHtml((task?.evidenceReferences || []).join('\n'))}</textarea></label><button class="button primary" type="submit">${task ? 'Save task' : 'Create task'}</button></form>`;
}

function taskCard(task) {
  const transitions = (TRANSITIONS[task.status] || [])
    .map(
      (status) =>
        `<button class="button tiny" data-action="transition-task" data-task-id="${escapeHtml(task.id)}" data-status="${status}">${escapeHtml(label(status))}</button>`,
    )
    .join('');
  return `<article class="task-card"><div class="task-card-main"><div class="task-title-line"><span class="status-dot status-${escapeHtml(task.status)}"></span><h3>${escapeHtml(task.title)}</h3><span class="badge priority-${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span></div><p class="muted">${escapeHtml(task.description || 'No description')}</p><div class="record-meta"><span>${escapeHtml(label(task.status))}</span><span>v${task.version}</span>${task.dueDate ? `<span>Due ${escapeHtml(task.dueDate)}</span>` : ''}<span>Updated ${formatDate(task.updatedAt)}</span></div></div><div class="task-card-actions"><button class="button ghost small" data-action="edit-task" data-task-id="${escapeHtml(task.id)}">Edit</button><div class="transition-actions">${transitions || '<span class="muted small-text">No further transitions</span>'}</div></div></article>`;
}

function renderHandoffs() {
  return `${pageHeader('TRANSFER LOG', 'Handoffs', 'Immutable records distinguish completed-work claims from evidence-backed results.', '<span class="read-only-label">Existing records are read-only</span>')}
    <div class="two-column-layout"><div class="stack"><section class="panel form-panel"><div class="panel-heading"><div><h2>Record a handoff</h2><p class="muted">The record cannot be edited or deleted after creation.</p></div></div>${handoffForm()}</section><section class="panel"><div class="panel-heading"><div><h2>Handoff history</h2><p class="muted">${state.handoffs.length} immutable record${state.handoffs.length === 1 ? '' : 's'}</p></div></div>${state.handoffs.length ? `<div class="handoff-list">${state.handoffs.map(handoffCard).join('')}</div>` : emptyState('No handoffs yet', 'Create a handoff when work moves to another agent or device.')}</section></div><aside>${state.selectedHandoff ? handoffDetail() : '<section class="panel detail-placeholder"><div class="empty-icon">↗</div><h2>Select a handoff</h2><p class="muted">Review claims, verified results, evidence, blockers, and next steps.</p></section>'}</aside></div>`;
}

function handoffForm() {
  return `<form id="handoff-form" class="stack"><label>Task ID <span class="optional">optional</span><input name="taskId" /></label><label>Summary<textarea name="summary" rows="3" required maxlength="10000"></textarea></label><label>Completed work <span class="optional">one claim per line</span><textarea name="completedWork" rows="4" required></textarea></label><label>Verified results <span class="optional">one result per line</span><textarea name="verifiedResults" rows="4"></textarea></label><label>Blockers <span class="optional">one per line</span><textarea name="blockers" rows="3"></textarea></label><label>Next steps <span class="optional">one per line</span><textarea name="nextSteps" rows="4" required></textarea></label><label>Evidence references <span class="optional">one per line</span><textarea name="evidenceReferences" rows="3"></textarea></label><label>Linked memory IDs <span class="optional">one UUID per line</span><textarea name="linkedMemoryIds" rows="2"></textarea></label><label>Linked task IDs <span class="optional">one UUID per line</span><textarea name="linkedTaskIds" rows="2"></textarea></label><label>Verification status<select name="verificationStatus"><option value="unverified">Unverified</option><option value="partially_verified">Partially verified</option><option value="verified">Verified</option></select></label><button class="button primary" type="submit">Create handoff</button></form>`;
}

function handoffCard(handoff) {
  const verified = handoff.verificationStatus === 'verified';
  return `<article class="handoff-card ${verified ? 'verified' : 'unverified'}"><div class="handoff-heading"><span class="verification-mark">${verified ? '✓' : '?'}</span><div><h3>${escapeHtml(handoff.summary)}</h3><span class="badge ${verificationClass(handoff.verificationStatus)}">${escapeHtml(label(handoff.verificationStatus))}</span></div><button class="button text" data-action="open-handoff" data-handoff-id="${escapeHtml(handoff.id)}">Open →</button></div><div class="claim-strip"><strong>Reported completed work</strong><span>${escapeHtml(handoff.completedWork?.[0] || 'No claim provided')}</span></div>${handoff.verifiedResults?.length ? `<div class="verified-strip"><strong>Verified result</strong><span>${escapeHtml(handoff.verifiedResults[0])}</span></div>` : '<div class="warning-strip">Completed-work claims are not verified results.</div>'}<div class="record-meta"><span>${formatDate(handoff.createdAt)}</span>${handoff.evidenceReferences?.length ? `<span>${handoff.evidenceReferences.length} evidence reference${handoff.evidenceReferences.length === 1 ? '' : 's'}</span>` : ''}</div></article>`;
}

function handoffDetail() {
  const handoff = state.selectedHandoff;
  return `<section class="panel form-panel"><div class="panel-heading"><div><h2>Handoff details</h2><p class="muted">Created ${formatDate(handoff.createdAt)}</p></div><button class="button ghost small" data-action="close-handoff">Close</button></div><div class="detail-meta"><span class="badge ${verificationClass(handoff.verificationStatus)}">${escapeHtml(label(handoff.verificationStatus))}</span><span class="read-only-label">immutable</span></div><div class="detail-section"><h3>Summary</h3><p>${escapeHtml(handoff.summary)}</p></div>${bulletSection('Reported completed work', handoff.completedWork, 'claim-list')}${bulletSection('Verified results', handoff.verifiedResults, 'verified-list')}${bulletSection('Blockers', handoff.blockers, 'claim-list')}${bulletSection('Next steps', handoff.nextSteps, 'claim-list')}${bulletSection('Evidence references', handoff.evidenceReferences, 'verified-list')}${bulletSection('Linked memory IDs', handoff.linkedMemoryIds, 'claim-list')}${bulletSection('Linked task IDs', handoff.linkedTaskIds, 'claim-list')}</section>`;
}

function renderActivity() {
  return `${pageHeader('AUDIT & ACCESS', 'Activity and security', 'Review project activity and device summaries available to this session.', '<button class="button ghost" data-action="refresh">Refresh</button>')}
    <div class="two-column-layout"><section class="panel"><div class="panel-heading"><div><h2>Project activity</h2><p class="muted">Append-only activity returned for this project.</p></div></div>${state.activity.length ? `<div class="activity-list">${state.activity.map((item) => `<article class="activity-item"><span class="activity-icon">${activityIcon(item.eventType)}</span><div><strong>${escapeHtml(label(item.eventType))}</strong><p>${escapeHtml(item.summary)}</p><small>${formatDate(item.createdAt)}${item.actorDeviceId ? ` · device ${escapeHtml(item.actorDeviceId.slice(0, 8))}` : ''}</small></div></article>`).join('')}</div>` : emptyState('No activity yet', 'Project activity will appear as work is recorded.')}</section><section class="panel"><div class="panel-heading"><div><h2>Devices</h2><p class="muted">Device summaries require the existing admin/owner permission.</p></div></div>${state.devices === null ? '<div class="loading-block">Loading devices…</div>' : state.devices.length ? `<div class="device-list">${state.devices.map((device) => `<article class="device-item"><span class="device-status ${device.status === 'active' ? 'active' : 'revoked'}"></span><div><strong>${escapeHtml(device.name)}</strong><p>${escapeHtml(device.deviceType)} · ${escapeHtml(device.role)}</p><small>${device.status === 'active' ? `Last seen ${formatDate(device.lastSeenAt || device.createdAt)}` : `Revoked ${formatDate(device.revokedAt)}`}</small></div><span class="badge">${escapeHtml(device.status)}</span></article>`).join('')}</div>` : emptyState('No device details', 'The current session cannot view device summaries.')}</section></div>
    <section class="panel diagnostics-panel"><div class="panel-heading"><div><h2>Local Runtime &amp; Diagnostics</h2><p class="muted">Desktop paths and runtime isolation configuration.</p></div></div>
      <div class="diagnostics-grid">
        <div class="diagnostics-card"><strong>Database location</strong><code>%APPDATA%\\OmniMemory\\omnimemory.sqlite</code><small>Authoritative local SQLite database</small></div>
        <div class="diagnostics-card"><strong>Diagnostics log</strong><code>%APPDATA%\\OmniMemory\\logs\\desktop.log</code><small>Redacted startup and runtime diagnostics</small></div>
        <div class="diagnostics-card"><strong>Network binding</strong><code>127.0.0.1 (Loopback only)</code><small>Rejects non-loopback connections</small></div>
        <div class="diagnostics-card"><strong>Desktop runtime</strong><code>Electron 45 / Node 24</code><small>Unpacked resources with owned child backend</small></div>
      </div>
    </section>`;
}

function taskRow(task) {
  return `<button class="record-row" data-action="edit-task" data-task-id="${escapeHtml(task.id)}"><span class="status-dot status-${escapeHtml(task.status)}"></span><span class="record-row-text"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(label(task.status))} · ${escapeHtml(task.priority)}</small></span><span class="row-arrow">→</span></button>`;
}

function memoryRow(memory) {
  return `<button class="record-row" data-action="open-memory" data-memory-id="${escapeHtml(memory.id)}"><span class="memory-symbol">✦</span><span class="record-row-text"><strong>${escapeHtml(memory.title)}</strong><small>${escapeHtml(label(memory.recordType))} · ${formatDate(memory.updatedAt)}</small></span><span class="row-arrow">→</span></button>`;
}

function memoryCard(memory) {
  return `<article class="memory-card"><div class="memory-card-heading"><div><span class="badge">${escapeHtml(label(memory.recordType))}</span><span class="badge ${verificationClass(memory.provenance?.verificationStatus)}">${escapeHtml(label(memory.provenance?.verificationStatus || 'unverified'))}</span></div><button class="button text" data-action="open-memory" data-memory-id="${escapeHtml(memory.id)}">Open →</button></div><h3>${escapeHtml(memory.title)}</h3><p>${escapeHtml(truncate(memory.content, 240))}</p><div class="record-meta"><span>Version ${memory.version}</span><span>${formatDate(memory.updatedAt)}</span></div></article>`;
}

function handoffRow(handoff) {
  return `<button class="record-row" data-action="open-handoff" data-handoff-id="${escapeHtml(handoff.id)}"><span class="verification-mark small">${handoff.verificationStatus === 'verified' ? '✓' : '?'}</span><span class="record-row-text"><strong>${escapeHtml(handoff.summary)}</strong><small>${escapeHtml(label(handoff.verificationStatus))} · ${formatDate(handoff.createdAt)}</small></span><span class="row-arrow">→</span></button>`;
}

function bulletSection(title, items = [], className = '') {
  return items?.length
    ? `<div class="detail-section"><h3>${escapeHtml(title)}</h3><ul class="${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
}

function emptyState(title, description) {
  return `<div class="empty-state"><div class="empty-icon">·</div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
}

function banner(message, type) {
  return `<div class="banner ${type}" role="alert"><span>${type === 'success' ? '✓' : '!'}</span><p>${escapeHtml(message)}</p></div>`;
}

async function initialize() {
  render();
  if ('serviceWorker' in navigator)
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  try {
    const setup = await api.get('/auth/setup/status');
    state.setupRequired = Boolean(setup?.setupRequired);
    state.authMode = state.setupRequired ? 'setup' : 'login';
  } catch (error) {
    state.error = safeError(error);
  }
  render();
}

async function submitAuth(form) {
  clearMessages();
  if (!form.reportValidity()) return;
  const setup = state.setupRequired === true;
  state.loading = setup ? 'Creating owner account' : 'Signing in';
  render();
  try {
    const body = formObject(form);
    let session;
    if (setup) {
      if (body.password !== body.passwordConfirmation) {
        throw new ApiError(400, 'PASSWORD_MISMATCH');
      }
      session = await api.createOwner({
        password: body.password,
        deviceName: body.deviceName,
        deviceType: body.deviceType,
      });
    } else {
      session = await api.post('/auth/login', body);
    }
    state.session = session;
    api.setToken(session.token);
    await api.get('/auth/me');
    state.setupRequired = false;
    state.authMode = 'login';
    await loadProjects();
    state.notice = setup ? 'Owner account created.' : 'Signed in.';
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function logout() {
  try {
    if (state.session) await api.post('/auth/logout', null);
  } catch {
    // Clear local state even if the session already expired.
  } finally {
    clearSession();
    state.notice = 'Signed out.';
    state.error = '';
    render();
  }
}

function clearSession() {
  api.clearToken();
  state.session = null;
  state.projects = [];
  state.projectId = null;
  state.tasks = [];
  state.memories = [];
  state.handoffs = [];
  state.activity = [];
  state.context = null;
  state.devices = null;
  state.selectedMemory = null;
  state.memoryHistory = [];
  state.selectedHandoff = null;
  state.editingTaskId = null;
  state.memorySearch = null;
  state.loading = '';
  state.warning = '';
}

async function loadProjects() {
  const projects = await api.get('/projects');
  state.projects = Array.isArray(projects) ? projects : [];
  if (!state.projects.some((project) => project.id === state.projectId))
    state.projectId = state.projects[0]?.id || null;
  if (state.projectId) await loadProjectData();
}

async function selectProject(projectId) {
  state.projectId = projectId || null;
  state.screen = 'dashboard';
  state.selectedMemory = null;
  state.selectedHandoff = null;
  clearMessages();
  if (state.projectId) await loadProjectData();
  else render();
}

async function loadProjectData() {
  if (!state.projectId || !state.session) return render();
  const projectId = state.projectId;
  state.loading = 'Loading latest project data';
  state.warning = '';
  render();
  const paths = [
    `/projects/${projectId}/context?limit=20`,
    `/projects/${projectId}/tasks?limit=100`,
    `/projects/${projectId}/memories/recent?limit=50`,
    `/projects/${projectId}/handoffs?limit=50`,
    `/projects/${projectId}/activity?limit=50`,
  ];
  const results = await Promise.allSettled(paths.map((path) => api.get(path)));
  if (state.projectId !== projectId || !state.session) return;
  const [context, tasks, memories, handoffs, activity] = results;
  if (context.status === 'fulfilled') state.context = context.value;
  if (tasks.status === 'fulfilled') state.tasks = Array.isArray(tasks.value) ? tasks.value : [];
  if (memories.status === 'fulfilled')
    state.memories = Array.isArray(memories.value) ? memories.value : [];
  if (handoffs.status === 'fulfilled')
    state.handoffs = Array.isArray(handoffs.value) ? handoffs.value : [];
  if (activity.status === 'fulfilled')
    state.activity = Array.isArray(activity.value) ? activity.value : [];
  if (results.some((result) => result.status === 'rejected'))
    state.warning = 'Some project data could not be loaded. Refresh to try again.';
  state.loading = '';
  render();
}

async function loadDevices() {
  try {
    const devices = await api.get('/devices');
    state.devices = Array.isArray(devices) ? devices : [];
  } catch (error) {
    state.devices = [];
    state.error = safeError(error);
  }
  render();
}

async function createProject(form) {
  clearMessages();
  if (!form.reportValidity()) return;
  state.loading = 'Creating project';
  render();
  try {
    const project = await api.post('/projects', {
      name: value(form, 'name'),
      description: value(form, 'description') || undefined,
    });
    state.notice = 'Project created.';
    await loadProjects();
    state.projectId = project.id;
    state.screen = 'dashboard';
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function searchMemories(form) {
  clearMessages();
  if (!form.reportValidity() || !state.projectId) return;
  state.loading = 'Searching memories';
  render();
  try {
    const params = new URLSearchParams({ query: value(form, 'query'), limit: '50' });
    const result = await api.get(`/projects/${state.projectId}/memories/search?${params}`);
    state.memorySearch = Array.isArray(result) ? result : [];
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function createMemory(form) {
  clearMessages();
  if (!form.reportValidity() || !state.projectId) return;
  state.loading = 'Saving memory';
  render();
  try {
    await api.post(
      `/projects/${state.projectId}/memories`,
      memoryPayload(form),
      idempotencyHeaders(),
    );
    state.notice = 'Memory saved.';
    state.memorySearch = null;
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function openMemory(memoryId) {
  if (!state.projectId || !memoryId) return;
  clearMessages();
  state.loading = 'Opening memory';
  render();
  try {
    const [memory, history] = await Promise.all([
      api.get(`/projects/${state.projectId}/memories/${memoryId}`),
      api.get(`/projects/${state.projectId}/memories/${memoryId}/history`),
    ]);
    state.selectedMemory = memory;
    state.memoryHistory = Array.isArray(history) ? history : [];
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function updateMemory(form) {
  clearMessages();
  if (!form.reportValidity() || !state.projectId) return;
  state.loading = 'Updating memory';
  render();
  try {
    const id = value(form, 'memoryId');
    state.selectedMemory = await api.patch(
      `/projects/${state.projectId}/memories/${id}`,
      memoryPayload(form, true),
      idempotencyHeaders(),
    );
    state.memoryHistory = await api.get(`/projects/${state.projectId}/memories/${id}/history`);
    state.notice = 'Memory updated.';
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function openTask(taskId) {
  if (!state.projectId || !taskId) return;
  clearMessages();
  try {
    const task = await api.get(`/projects/${state.projectId}/tasks/${taskId}`);
    replaceTask(task);
    state.editingTaskId = taskId;
    state.screen = 'tasks';
  } catch (error) {
    state.error = safeError(error);
  }
  render();
}

async function saveTask(form) {
  clearMessages();
  if (!form.reportValidity() || !state.projectId) return;
  state.loading = value(form, 'taskId') ? 'Updating task' : 'Creating task';
  render();
  try {
    const taskId = value(form, 'taskId');
    const body = {
      title: value(form, 'title'),
      description: value(form, 'description') || undefined,
      priority: value(form, 'priority'),
      dueDate: value(form, 'dueDate') || undefined,
      assignedDeviceId: value(form, 'assignedDeviceId') || undefined,
      linkedMemoryIds: lines(value(form, 'linkedMemoryIds')),
      evidenceReferences: lines(value(form, 'evidenceReferences')),
    };
    if (taskId) {
      body.description = value(form, 'description') || null;
      body.expectedVersion = Number(value(form, 'expectedVersion'));
      if (!body.assignedDeviceId) body.assignedDeviceId = null;
      if (!body.dueDate) body.dueDate = null;
      replaceTask(
        await api.patch(`/projects/${state.projectId}/tasks/${taskId}`, body, idempotencyHeaders()),
      );
      state.notice = 'Task updated.';
    } else {
      state.tasks.unshift(
        await api.post(`/projects/${state.projectId}/tasks`, body, idempotencyHeaders()),
      );
      state.notice = 'Task created.';
    }
    state.editingTaskId = null;
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function transitionTask(taskId, status) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !state.projectId || !TRANSITIONS[task.status]?.includes(status)) return;
  clearMessages();
  state.loading = 'Updating task status';
  render();
  try {
    replaceTask(
      await api.post(
        `/projects/${state.projectId}/tasks/${taskId}/transitions`,
        { expectedVersion: task.version, status },
        idempotencyHeaders(),
      ),
    );
    state.notice = `Task moved to ${label(status)}.`;
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function openHandoff(handoffId) {
  if (!state.projectId || !handoffId) return;
  clearMessages();
  state.loading = 'Opening handoff';
  render();
  try {
    state.selectedHandoff = await api.get(`/projects/${state.projectId}/handoffs/${handoffId}`);
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

async function createHandoff(form) {
  clearMessages();
  if (!form.reportValidity() || !state.projectId) return;
  const verifiedResults = lines(value(form, 'verifiedResults'));
  const evidenceReferences = lines(value(form, 'evidenceReferences'));
  const verificationStatus = value(form, 'verificationStatus');
  if (
    verificationStatus !== 'unverified' &&
    !verifiedResults.length &&
    !evidenceReferences.length
  ) {
    state.error =
      'Partially verified and verified handoffs need a verified result or evidence reference.';
    render();
    return;
  }
  state.loading = 'Creating handoff';
  render();
  try {
    const created = await api.post(
      `/projects/${state.projectId}/handoffs`,
      {
        taskId: value(form, 'taskId') || undefined,
        summary: value(form, 'summary'),
        completedWork: lines(value(form, 'completedWork')),
        verifiedResults,
        blockers: lines(value(form, 'blockers')),
        nextSteps: lines(value(form, 'nextSteps')),
        evidenceReferences,
        linkedMemoryIds: lines(value(form, 'linkedMemoryIds')),
        linkedTaskIds: lines(value(form, 'linkedTaskIds')),
        verificationStatus,
      },
      idempotencyHeaders(),
    );
    state.handoffs.unshift(created);
    state.selectedHandoff = created;
    state.notice = 'Handoff recorded. It is immutable after creation.';
    await loadProjectData();
  } catch (error) {
    state.error = safeError(error);
  } finally {
    state.loading = '';
    render();
  }
}

function memoryPayload(form, updating = false) {
  const payload = {
    recordType: value(form, 'recordType'),
    title: value(form, 'title'),
    content: value(form, 'content'),
    provenance: {
      sourceKind: value(form, 'sourceKind'),
      verificationStatus: value(form, 'verificationStatus'),
      sourceReference: value(form, 'sourceReference') || undefined,
      verificationMethod: value(form, 'verificationMethod') || undefined,
    },
  };
  if (updating) {
    payload.expectedVersion = Number(value(form, 'expectedVersion'));
    payload.changeReason = value(form, 'changeReason') || undefined;
  }
  return payload;
}

function replaceTask(task) {
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.projectId);
}

function formObject(form) {
  const result = {};
  for (const element of form.elements) if (element.name) result[element.name] = element.value;
  return result;
}

function value(form, name) {
  return form.elements.namedItem(name)?.value?.trim() || '';
}

function lines(text) {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function idempotencyHeaders() {
  const id =
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { 'Idempotency-Key': id };
}

function clearMessages() {
  state.error = '';
  state.notice = '';
  state.warning = '';
}

function safeError(error) {
  return error instanceof ApiError
    ? error.message
    : 'The request could not be completed. Try again.';
}

function verificationClass(status) {
  if (status === 'verified' || status === 'test_verified' || status === 'user_confirmed')
    return 'verified-badge';
  if (status === 'partially_verified') return 'partial-badge';
  return 'unverified-badge';
}

function activityIcon(type) {
  if (type === 'test_recorded') return '✓';
  if (type === 'task_started' || type === 'task_updated') return '↗';
  if (type === 'finding_recorded') return '!';
  return '•';
}

function label(value) {
  return String(value || '').replaceAll('_', ' ');
}

function formatDate(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'unknown time'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character],
  );
}

function memoryRecordOptions(selected = 'note') {
  return ['note', 'finding', 'project_fact', 'constraint', 'requirement', 'profile']
    .map(
      (item) =>
        `<option value="${item}" ${selected === item ? 'selected' : ''}>${escapeHtml(label(item))}</option>`,
    )
    .join('');
}

function memorySourceOptions(selected = 'user_provided') {
  return ['user_provided', 'file_observed', 'system_observed', 'agent_inferred', 'test_result']
    .map(
      (item) =>
        `<option value="${item}" ${selected === item ? 'selected' : ''}>${escapeHtml(label(item))}</option>`,
    )
    .join('');
}

function verificationOptions(selected = 'unverified') {
  return ['unverified', 'user_confirmed', 'test_verified', 'disputed', 'superseded']
    .map(
      (item) =>
        `<option value="${item}" ${selected === item ? 'selected' : ''}>${escapeHtml(label(item))}</option>`,
    )
    .join('');
}

initialize();
