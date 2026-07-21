import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASK_STATUSES,
  normalizeTaskStack,
  taskStackFromToolEvent,
  taskStackProgress,
  updateTaskStackStore,
} from '../extension/lib/task-stack.mjs';

test('normalizes Hermes todo tool input and keeps the declared order', () => {
  const tasks = taskStackFromToolEvent({
    type: 'tool.started',
    data: {
      tool_name: 'todo',
      input: {
        todos: [
          { id: 'audit', content: 'Audit Desktop task lifecycle', status: 'completed' },
          { id: 'surface', content: 'Build Web + Browser surfaces', status: 'in_progress' },
          { id: 'qa', content: 'Run theme and narrow-panel QA', status: 'pending' },
        ],
      },
    },
  });
  assert.deepEqual(tasks.map((task) => task.id), ['audit', 'surface', 'qa']);
  assert.deepEqual(tasks.map((task) => task.status), ['completed', 'in_progress', 'pending']);
});

test('accepts JSON-string results and rejects unrelated tools', () => {
  const tasks = taskStackFromToolEvent({
    name: 'tool.finished',
    toolName: 'todo',
    data: { output: JSON.stringify({ todos: [{ id: 'one', content: 'One task', status: 'done' }] }) },
  });
  assert.equal(tasks[0].status, TASK_STATUSES.COMPLETED);
  assert.equal(taskStackFromToolEvent({ toolName: 'terminal', data: { todos: [{ id: 'x', content: 'No', status: 'pending' }] } }), null);
});

test('normalization bounds content, removes invalid rows, and guarantees one active status', () => {
  const tasks = normalizeTaskStack([
    { id: 'first', content: 'A'.repeat(500), status: 'working' },
    { id: 'second', content: 'Second', status: 'in-progress' },
    { id: '', content: '', status: 'pending' },
    { id: 'third', content: 'Third', status: 'cancelled' },
  ]);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].content.length, 300);
  assert.equal(tasks[0].status, 'in_progress');
  assert.equal(tasks[1].status, 'pending');
  assert.equal(tasks[2].status, 'cancelled');
});

test('progress exposes totals and a stable percentage', () => {
  assert.deepEqual(taskStackProgress([
    { status: 'completed' },
    { status: 'in_progress' },
    { status: 'pending' },
    { status: 'cancelled' },
  ]), {
    total: 4,
    completed: 1,
    active: 1,
    pending: 1,
    cancelled: 1,
    percent: 25,
  });
});

test('per-session storage is capped and updates recency without leaking task payloads across sessions', () => {
  let store = {};
  for (let index = 0; index < 55; index += 1) {
    store = updateTaskStackStore(store, `session-${index}`, [{ id: `task-${index}`, content: `Task ${index}`, status: 'pending' }], { now: index });
  }
  assert.equal(Object.keys(store).length, 50);
  assert.equal(store['session-0'], undefined);
  assert.equal(store['session-54'].tasks[0].content, 'Task 54');
  assert.equal(store['session-54'].updatedAt, 54);
});
