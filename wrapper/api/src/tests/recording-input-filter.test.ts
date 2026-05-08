import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterRowsBySerializedRecordingInput,
  matchesWorkflowRecordingSerializedInputFilter,
  normalizeWorkflowRecordingInputFilter,
} from '../routes/workflows/recording-input-filter.js';

function createSerializedRecording(input: unknown, strings: Record<string, string> = {}): string {
  return JSON.stringify({
    version: 1,
    recording: {
      recordingId: 'recording-filter-test',
      events: [
        {
          type: 'start',
          data: {
            inputs: {
              input: {
                type: 'any',
                value: input,
              },
            },
          },
          ts: 1,
        },
      ],
      startTs: 1,
      finishTs: 1,
    },
    assets: {},
    strings,
  });
}

test('recording input filters use the workflow request input as the JSON path root', () => {
  const serializedRecording = createSerializedRecording({ foo: 'bar', score: 12 });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.foo', operator: '==', value: 'bar' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.foo', operator: '==', value: ' bar ' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.score', operator: '>', value: '10' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'exists', value: '' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'not_exists', value: '' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: '==', value: '{"score":12,"foo":"bar"}' },
    ),
    true,
  );
});

test('recording input filters restore serialized string table references before matching', () => {
  const serializedRecording = createSerializedRecording({ foo: '$STRING:1234' }, { 1234: 'a long stored value' });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.foo', operator: 'contains', value: 'stored' },
    ),
    true,
  );
});

test('recording input filters do not match recordings without a captured root input', () => {
  const serializedRecording = JSON.stringify({
    version: 1,
    recording: {
      recordingId: 'missing-input-recording',
      events: [],
      startTs: 1,
      finishTs: 1,
    },
    assets: {},
    strings: {},
  });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.foo', operator: 'not_exists', value: '' },
    ),
    false,
  );
});

test('recording input filter normalization rejects invalid paths and operators', () => {
  assert.deepEqual(
    normalizeWorkflowRecordingInputFilter({ path: ' $.foo ', operator: undefined, value: 'bar' }),
    { path: '$.foo', operator: '==', value: 'bar' },
  );
  assert.throws(
    () => normalizeWorkflowRecordingInputFilter({ path: 'foo', operator: '==', value: 'bar' }),
    /must start with \$/,
  );
  assert.throws(
    () => normalizeWorkflowRecordingInputFilter({ path: '$.foo', operator: 'roughly', value: 'bar' }),
    /Unsupported recording input filter operator/,
  );
});

test('recording input row filtering preserves order and bounds artifact reads', async () => {
  const rows = [
    { id: 'first', serialized: createSerializedRecording({ foo: 'bar' }) },
    { id: 'second', serialized: createSerializedRecording({ foo: 'baz' }) },
    { id: 'third', serialized: createSerializedRecording({ foo: 'bar' }) },
  ];

  const filteredRows = await filterRowsBySerializedRecordingInput(
    rows,
    { path: '$.foo', operator: '==', value: 'bar' },
    async (row) => row.serialized,
  );

  assert.deepEqual(filteredRows.map((row) => row.id), ['first', 'third']);
});
