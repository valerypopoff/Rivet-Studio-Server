import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface StreamingExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface StreamingExec extends EventEmitter {
  /** Emitted for each chunk of output: (source: 'stdout'|'stderr', data: string) */
  on(event: 'data', listener: (source: 'stdout' | 'stderr', data: string) => void): this;
  /** Emitted when the process exits: (code: number) */
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  process: ChildProcess;
}

export function execStreaming(
  program: string,
  args: string[],
  options: StreamingExecOptions = {},
): StreamingExec {
  const emitter = new EventEmitter() as StreamingExec;

  const proc = spawn(program, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env,
  });

  emitter.process = proc;

  proc.stdout.on('data', (data: Buffer) => {
    emitter.emit('data', 'stdout', data.toString());
  });

  proc.stderr.on('data', (data: Buffer) => {
    emitter.emit('data', 'stderr', data.toString());
  });

  proc.on('close', (code) => {
    emitter.emit('exit', code ?? 1);
  });

  proc.on('error', (err) => {
    emitter.emit('error', err);
  });

  return emitter;
}
