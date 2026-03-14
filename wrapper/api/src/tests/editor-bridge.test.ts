import assert from 'node:assert/strict';
import test from 'node:test';

import * as editorBridgeModule from '../../../shared/editor-bridge.js';

const editorBridge = (editorBridgeModule as typeof editorBridgeModule & { default?: typeof editorBridgeModule }).default ?? editorBridgeModule;
const { isDashboardToEditorCommand, isEditorToDashboardEvent } = editorBridge;

test('editor bridge accepts valid dashboard commands', () => {
  assert.equal(isDashboardToEditorCommand({ type: 'save-project' }), true);
  assert.equal(
    isDashboardToEditorCommand({
      type: 'open-project',
      path: '/tmp/example.rivet-project',
      replaceCurrent: false,
    }),
    true,
  );
  assert.equal(
    isDashboardToEditorCommand({
      type: 'workflow-paths-moved',
      moves: [{ fromAbsolutePath: '/a', toAbsolutePath: '/b' }],
    }),
    true,
  );
});

test('editor bridge rejects malformed messages', () => {
  assert.equal(isDashboardToEditorCommand({ type: 'open-project', path: '/tmp/example.rivet-project' }), false);
  assert.equal(isEditorToDashboardEvent({ type: 'project-saved' }), false);
  assert.equal(isEditorToDashboardEvent({ type: 'unknown' }), false);
});

test('editor bridge accepts valid editor events', () => {
  assert.equal(isEditorToDashboardEvent({ type: 'editor-ready' }), true);
  assert.equal(isEditorToDashboardEvent({ type: 'project-saved', path: '/tmp/example.rivet-project' }), true);
  assert.equal(isEditorToDashboardEvent({ type: 'open-project-count-changed', count: 2 }), true);
});
