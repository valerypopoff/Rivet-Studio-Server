// Docker-specific executor bundler: runs only the esbuild step from
// rivet/packages/app-executor/scripts/build-executor.mts, skipping
// the pkg native-binary compilation that requires rustc.

const esbuild = require('esbuild');
const path = require('path');

const appExecutorDir = path.resolve(__dirname, '..', 'rivet', 'packages', 'app-executor');

// Patch the WS server to bind 0.0.0.0 instead of localhost inside Docker
const patchDockerHost = {
  name: 'patch-docker-host',
  setup(build) {
    const fs = require('fs');
    build.onLoad({ filter: /debugger\.ts$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = contents.replace("host = 'localhost'", "host = '0.0.0.0'");
      return { contents, loader: 'ts' };
    });
  },
};

const resolveRivet = {
  name: 'resolve-rivet',
  setup(build) {
    build.onResolve({ filter: /^@ironclad\/rivet-/ }, (args) => {
      const rivetPackage = args.path.replace(/^@ironclad\/rivet-/, '');
      return {
        path: path.resolve(appExecutorDir, '..', rivetPackage, 'src', 'index.ts'),
      };
    });
  },
};

esbuild.build({
  entryPoints: [path.join(appExecutorDir, 'bin', 'executor.mts')],
  bundle: true,
  platform: 'node',
  outfile: path.join(appExecutorDir, 'bin', 'executor-bundle.cjs'),
  format: 'cjs',
  target: 'node16',
  external: [],
  plugins: [patchDockerHost, resolveRivet],
}).then(() => {
  console.log('Executor bundled to bin/executor-bundle.cjs (pkg step skipped for Docker)');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
