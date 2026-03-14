import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { currentNodeModulesPath } from './manifest.js';

interface CodeRunnerOptions {
  includeFetch: boolean;
  includeRequire: boolean;
  includeRivet: boolean;
  includeProcess: boolean;
  includeConsole: boolean;
}

interface DataValue {
  type: string;
  value: unknown;
}

type Inputs = Record<string, DataValue>;
type Outputs = Record<string, DataValue>;

/**
 * A wrapper-owned CodeRunner that resolves packages from the active managed
 * runtime-library release. Falls back to standard Node module resolution
 * (NODE_PATH) when no managed release exists.
 *
 * Implements the CodeRunner interface from @ironclad/rivet-core without
 * importing it directly, since the API depends on @ironclad/rivet-node
 * which re-exports everything.
 */
export class ManagedCodeRunner {
  constructor(private runtimeLibrariesRoot: string) {}

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    const argNames: string[] = ['inputs'];
    const args: unknown[] = [inputs];

    if (options.includeConsole) {
      argNames.push('console');
      args.push(console);
    }

    if (options.includeRequire) {
      argNames.push('require');
      const requireFn = this.createManagedRequire();
      args.push(requireFn);
    }

    if (options.includeProcess) {
      argNames.push('process');
      args.push(process);
    }

    if (options.includeFetch) {
      argNames.push('fetch');
      args.push(globalThis.fetch);
    }

    if (options.includeRivet) {
      argNames.push('Rivet');
      // Dynamically import rivet-node so we don't create a hard circular dep
      const rivet = await import('@ironclad/rivet-node');
      args.push(rivet);
    }

    if (graphInputs) {
      argNames.push('graphInputs');
      args.push(graphInputs);
    }

    if (contextValues) {
      argNames.push('context');
      args.push(contextValues);
    }

    argNames.push(code);

    const AsyncFunction = async function () {}.constructor as new (...args: string[]) => Function;
    const codeFunction = new AsyncFunction(...argNames);
    const outputs = await codeFunction(...args);

    return outputs;
  }

  private createManagedRequire(): NodeRequire {
    const nodeModulesPath = currentNodeModulesPath();
    if (nodeModulesPath && fs.existsSync(nodeModulesPath)) {
      const virtualEntry = path.join(nodeModulesPath, '__virtual.cjs');
      return createRequire(virtualEntry);
    }

    // Fallback: standard require using NODE_PATH
    return createRequire(import.meta.url);
  }
}
