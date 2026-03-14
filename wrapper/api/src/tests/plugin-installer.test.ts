import assert from 'node:assert/strict';
import test from 'node:test';

const pluginInstaller = await import('../routes/plugin-installer.js');

test('plugin installer encodes scoped package metadata URLs', () => {
  assert.equal(
    pluginInstaller.getPluginRegistryMetadataUrl('@scope/example-plugin', 'latest'),
    'https://registry.npmjs.org/%40scope%2Fexample-plugin/latest',
  );
});

test('plugin installer rejects invalid package names and tags', () => {
  assert.throws(() => pluginInstaller.normalizePluginPackageName('../plugin'), /Invalid plugin package name/);
  assert.throws(() => pluginInstaller.normalizePluginTag('../latest'), /Invalid plugin tag/);
  assert.throws(() => pluginInstaller.normalizePluginTag('feature/test'), /Invalid plugin tag/);
});
