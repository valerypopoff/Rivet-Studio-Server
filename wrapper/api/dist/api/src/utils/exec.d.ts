import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
interface ExecOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    maxOutputBytes?: number;
}
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export interface StreamingExec extends EventEmitter {
    on(event: 'data', listener: (source: 'stdout' | 'stderr', data: string) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    process: ChildProcess;
}
export declare function exec(program: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
export declare function execStreaming(program: string, args: string[], options?: ExecOptions): StreamingExec;
export {};
