import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { activeReleaseNodeModulesPath } from './manifest.js';
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
    runtimeLibrariesRoot;
    constructor(runtimeLibrariesRoot) {
        this.runtimeLibrariesRoot = runtimeLibrariesRoot;
    }
    async runCode(code, inputs, options, graphInputs, contextValues) {
        const argNames = ['inputs'];
        const args = [inputs];
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
        const AsyncFunction = async function () { }.constructor;
        const codeFunction = new AsyncFunction(...argNames);
        const outputs = await codeFunction(...args);
        return outputs;
    }
    createManagedRequire() {
        const nodeModulesPath = activeReleaseNodeModulesPath();
        if (nodeModulesPath && fs.existsSync(nodeModulesPath)) {
            const virtualEntry = path.join(nodeModulesPath, '__virtual.cjs');
            return createRequire(virtualEntry);
        }
        // Fallback: standard require using NODE_PATH
        return createRequire(import.meta.url);
    }
}
