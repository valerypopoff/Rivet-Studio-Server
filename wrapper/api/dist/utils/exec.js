import { spawn } from 'node:child_process';
export function execCommand(program, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(program, args, {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const maxOutput = options.maxOutputBytes ?? Infinity;
        proc.stdout.on('data', (data) => {
            stdoutBytes += data.length;
            if (stdoutBytes <= maxOutput)
                stdout += data.toString();
        });
        proc.stderr.on('data', (data) => {
            stderrBytes += data.length;
            if (stderrBytes <= maxOutput)
                stderr += data.toString();
        });
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        proc.on('error', reject);
    });
}
