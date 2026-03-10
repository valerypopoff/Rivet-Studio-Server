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
export declare class ManagedCodeRunner {
    private runtimeLibrariesRoot;
    constructor(runtimeLibrariesRoot: string);
    runCode(code: string, inputs: Inputs, options: CodeRunnerOptions, graphInputs?: Record<string, DataValue>, contextValues?: Record<string, DataValue>): Promise<Outputs>;
    private createManagedRequire;
}
export {};
