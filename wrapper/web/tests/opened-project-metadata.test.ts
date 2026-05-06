import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '@valerypopoff/rivet2-core';
import {
  resolveHostedProjectTitleFromPath,
  resolveHostedProjectTitle,
  withHostedProjectTitle,
} from '../dashboard/openedProjectMetadata';

function makeProject(title: string | undefined): Project {
  return {
    metadata: {
      id: 'project-1' as Project['metadata']['id'],
      title: title as string,
      description: '',
    },
    graphs: {},
  };
}

test('resolveHostedProjectTitle prefers a non-empty project metadata title', () => {
  assert.equal(resolveHostedProjectTitle(makeProject('Billing Flow'), '/workflows/fallback.rivet-project'), 'Billing Flow');
});

test('resolveHostedProjectTitle falls back to the project filename when metadata title is missing', () => {
  assert.equal(resolveHostedProjectTitle(makeProject(undefined), '/workflows/published-demo.rivet-project'), 'published-demo');
  assert.equal(resolveHostedProjectTitle(makeProject('   '), 'D:\\Programming\\workflows\\Windows Demo.rivet-project'), 'Windows Demo');
  assert.equal(resolveHostedProjectTitle(makeProject('undefined'), '/workflows/bad-title.rivet-project'), 'bad-title');
  assert.equal(resolveHostedProjectTitle(makeProject('null'), '/workflows/null-title.rivet-project'), 'null-title');
});

test('resolveHostedProjectTitleFromPath resolves the file-tree project title without consulting metadata', () => {
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/My Flow.rivet-project'), 'My Flow');
  assert.equal(resolveHostedProjectTitleFromPath('D:\\Programming\\workflows\\Windows Demo.rivet-project'), 'Windows Demo');
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/No Extension'), 'No Extension');
  assert.equal(resolveHostedProjectTitleFromPath('/workflows/readme.md'), 'readme.md');
  assert.equal(resolveHostedProjectTitleFromPath('   '), null);
  assert.equal(resolveHostedProjectTitleFromPath(null), null);
});

test('withHostedProjectTitle normalizes missing project metadata titles without changing titled projects', () => {
  const titledProject = makeProject('Already Named');
  const fallbackProject = makeProject(undefined);

  assert.equal(withHostedProjectTitle(titledProject, '/workflows/ignored.rivet-project'), titledProject);
  assert.equal(withHostedProjectTitle(fallbackProject, '/workflows/fallback.rivet-project').metadata.title, 'fallback');
});
