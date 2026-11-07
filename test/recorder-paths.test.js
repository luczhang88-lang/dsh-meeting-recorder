import assert from 'node:assert/strict';
import test from 'node:test';
import { join, sep } from 'node:path';

const ENV_KEYS = [
  'MEETING_RECORDER_ENGINE_ROOT',
  'DSH_SPEECH_ENGINE_ROOT',
  'MEETING_RECORDER_PYTHON',
  'DSH_MEETING_PYTHON',
  'MEETING_RECORDER_MODEL_CACHE',
  'MODELSCOPE_CACHE',
  'MEETING_RECORDER_MEETINGS_ROOT',
  'DSH_MEETING_RECORDS',
];

for (const key of ENV_KEYS) delete process.env[key];

const { MeetingRecorder } = await import('../host/recorder.js');
const { RecorderTransport } = await import('../host/transport.js');

test('default engineRoot is the engine directory beside the plugin', () => {
  const recorder = new MeetingRecorder({}, {});
  assert.equal(recorder.engineRoot.endsWith(`${sep}engine`), true);
  const snapshot = recorder.engineSnapshot();
  assert.equal(snapshot.bundled, true);
  assert.equal(snapshot.canSetupHere, true);
  assert.equal(snapshot.pythonReady, false);
  assert.equal(snapshot.modelCacheDir, join(recorder.engineRoot, 'models'));
  assert.match(snapshot.setupScript, /setup\.(sh|ps1)$/);
});

test('a custom engineRoot is not treated as the bundled engine', () => {
  const recorder = new MeetingRecorder({}, { engineRoot: '/tmp/other-engine' });
  const snapshot = recorder.engineSnapshot();
  assert.equal(snapshot.bundled, false);
  assert.equal(snapshot.canSetupHere, false);
  assert.equal(snapshot.engineRoot.endsWith(`${sep}other-engine`), true);
});

test('transport exposes setup operations and engine status', () => {
  const recorder = new MeetingRecorder({}, {});
  const transport = new RecorderTransport({
    recorder,
    jobs: { activeCount: () => 0 },
    deliverables: {},
  });
  for (const op of ['setup/start', 'setup/status', 'setup/cancel', 'selfcheck', 'models']) {
    assert.equal(typeof transport.ops[op], 'function', op);
  }
  const status = transport.status();
  assert.equal(status.engine.bundled, true);
  assert.equal(status.setup.phase, 'idle');
});
