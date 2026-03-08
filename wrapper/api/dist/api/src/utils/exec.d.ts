interface ExecOptions {
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
}
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export declare function execCommand(program: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
export {};
