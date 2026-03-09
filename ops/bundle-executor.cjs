// Docker-specific executor bundler: runs only the esbuild step from
// rivet/packages/app-executor/scripts/build-executor.mts, skipping
// the pkg native-binary compilation that requires rustc.

const esbuild = require('esbuild');
const path = require('path');

const appExecutorDir = path.resolve(__dirname, '..', 'rivet', 'packages', 'app-executor');
const wrapperExecutorDir = path.resolve(__dirname, '..', 'wrapper', 'executor');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOrThrow(contents, searchValue, replaceValue, description) {
  const pattern = new RegExp(escapeRegExp(searchValue).replace(/\n/g, '\\r?\\n'));

  if (!pattern.test(contents)) {
    throw new Error(`Failed to apply executor bundle patch: ${description}`);
  }

  return contents.replace(pattern, replaceValue);
}

// Patch the WS server to bind 0.0.0.0 instead of localhost inside Docker
const patchDockerHost = {
  name: 'patch-docker-host',
  setup(build) {
    const fs = require('fs');
    build.onLoad({ filter: /debugger\.ts$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = replaceOrThrow(contents, "host = 'localhost'", "host = '0.0.0.0'", 'debugger host binding');
      return { contents, loader: 'ts' };
    });

    build.onLoad({ filter: /executor\.mts$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = replaceOrThrow(
        contents,
        'const datasetProvider = new DebuggerDatasetProvider();',
        `const datasetProvider = new DebuggerDatasetProvider();

const formatHostedTraceArg = (value) => {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const sendHostedTrace = (client, level, args) => {
  const message = args.map((value) => formatHostedTraceArg(value)).join(' ');

  if (!message) {
    return;
  }

  try {
    if (client.readyState === 1) {
      client.send(
        JSON.stringify({
          message: 'trace',
          data: {
            source: 'stdout',
            level,
            message,
          },
        }),
      );
    }
  } catch {}
};`,
        'executor hosted trace helper injection'
      );
      contents = replaceOrThrow(
        contents,
        'dynamicGraphRun: async ({ graphId, inputs, runToNodeIds, contextValues, runFromNodeId, projectPath }) => {',
        'dynamicGraphRun: async ({ client, graphId, inputs, runToNodeIds, contextValues, runFromNodeId, projectPath }) => {',
        'dynamicGraphRun client parameter'
      );
      contents = replaceOrThrow(
        contents,
        'console.log(`Running graph ${graphId} with inputs:`, inputs);',
        "console.log(`Running graph ${graphId} with inputs:`, inputs);\n    sendHostedTrace(client, 'log', [`Running graph ${graphId} with inputs:`, inputs]);",
        'run lifecycle trace forwarding'
      );
      contents = replaceOrThrow(
        contents,
        'console.warn(`Cannot run graph ${graphId} because no project is uploaded.`);',
        "console.warn(`Cannot run graph ${graphId} because no project is uploaded.`);\n      sendHostedTrace(client, 'warn', [`Cannot run graph ${graphId} because no project is uploaded.`]);",
        'missing project warning trace forwarding'
      );
      contents = replaceOrThrow(
        contents,
        'console.log(`Enabled plugin ${spec.id}.`);',
        "console.log(`Enabled plugin ${spec.id}.`);\n        sendHostedTrace(client, 'log', [`Enabled plugin ${spec.id}.`]);",
        'plugin enable trace forwarding'
      );
      contents = replaceOrThrow(
        contents,
        'console.error(`Failed to enable plugin ${spec.id}.`, err);',
        "console.error(`Failed to enable plugin ${spec.id}.`, err);\n        sendHostedTrace(client, 'error', [`Failed to enable plugin ${spec.id}.`, err]);",
        'plugin failure trace forwarding'
      );
      contents = replaceOrThrow(
        contents,
        "        onTrace: (trace) => {\n          console.log(trace);\n        },",
        "        onTrace: (trace) => {\n          console.log(trace);\n          sendHostedTrace(client, 'log', [trace]);\n        },",
        'processor trace forwarding'
      );
      contents = replaceOrThrow(
        contents,
        'await processor.run();',
        `const hostedConsoleState = globalThis;
      const previousHostedConsoleSink = hostedConsoleState.__RIVET_HOSTED_CONSOLE_SINK__;
      hostedConsoleState.__RIVET_HOSTED_CONSOLE_SINK__ = (level, args) => {
        sendHostedTrace(client, level, args);
      };

      try {
        await processor.run();
      } finally {
        hostedConsoleState.__RIVET_HOSTED_CONSOLE_SINK__ = previousHostedConsoleSink;
      }`,
        'hosted console sink around processor run'
      );
      contents = replaceOrThrow(
        contents,
        'console.error(err);',
        "console.error(err);\n      sendHostedTrace(client, 'error', [err]);",
        'executor error trace forwarding'
      );
      return { contents, loader: 'ts' };
    });

    build.onLoad({ filter: /NodeCodeRunner\.ts$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = replaceOrThrow(
        contents,
        '      args.push(console);',
        `      const hostedConsoleState = globalThis as typeof globalThis & {
        __RIVET_HOSTED_CONSOLE_SINK__?: (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => void;
      };
      const originalConsole = console;
      const forwardHostedConsole = (level: 'log' | 'info' | 'warn' | 'error' | 'debug', values: unknown[]) => {
        hostedConsoleState.__RIVET_HOSTED_CONSOLE_SINK__?.(level, values);
      };
      args.push({
        ...originalConsole,
        log: (...values: unknown[]) => {
          originalConsole.log(...values);
          forwardHostedConsole('log', values);
        },
        info: (...values: unknown[]) => {
          originalConsole.info(...values);
          forwardHostedConsole('info', values);
        },
        warn: (...values: unknown[]) => {
          originalConsole.warn(...values);
          forwardHostedConsole('warn', values);
        },
        error: (...values: unknown[]) => {
          originalConsole.error(...values);
          forwardHostedConsole('error', values);
        },
        debug: (...values: unknown[]) => {
          originalConsole.debug(...values);
          forwardHostedConsole('debug', values);
        },
      });`,
        'NodeCodeRunner console wrapping'
      );
      contents = replaceOrThrow(
        contents,
        '      const require = import.meta ? createRequire(import.meta.url) : module.require;',
        "      const require = createRequire(process.cwd() + '/executor-bundle.cjs');",
        'NodeCodeRunner require resolution'
      );
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
  nodePaths: [path.join(wrapperExecutorDir, 'node_modules')],
  plugins: [patchDockerHost, resolveRivet],
}).then(() => {
  console.log('Executor bundled to bin/executor-bundle.cjs (pkg step skipped for Docker)');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
