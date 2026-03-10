import { spawn, type ChildProcess } from 'node:child_process';
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

export function exec(
  program: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutput = options.maxOutputBytes ?? Infinity;

    proc.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes <= maxOutput) stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes <= maxOutput) stderr += data.toString();
    });

    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on('error', reject);
  });
}

export function execStreaming(
  program: string,
  args: string[],
  options: ExecOptions = {},
): StreamingExec {
  const emitter = new EventEmitter() as StreamingExec;

  const proc = spawn(program, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
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
