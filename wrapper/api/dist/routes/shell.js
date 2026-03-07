import { Router } from 'express';
import { spawn } from 'node:child_process';
import { isShellAllowed, getCommandTimeout, getMaxOutputBytes, validatePath } from '../security.js';
export const shellRouter = Router();
// POST /api/shell/exec
shellRouter.post('/exec', async (req, res) => {
    try {
        const { program, args = [], options = {} } = req.body;
        if (!isShellAllowed(program)) {
            res.status(403).json({ error: `Command not allowed: ${program}` });
            return;
        }
        // Validate cwd if provided
        let cwd = options.cwd;
        if (cwd) {
            cwd = validatePath(cwd);
        }
        const timeout = getCommandTimeout();
        const maxOutput = getMaxOutputBytes();
        const result = await execCommand(program, args, { cwd, timeout, maxOutput });
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
function execCommand(program, args, options) {
    return new Promise((resolve, reject) => {
        const proc = spawn(program, args, {
            cwd: options.cwd,
            timeout: options.timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdoutBytes += data.length;
            if (stdoutBytes <= options.maxOutput) {
                stdout += chunk;
            }
        });
        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderrBytes += data.length;
            if (stderrBytes <= options.maxOutput) {
                stderr += chunk;
            }
        });
        proc.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });
        proc.on('error', (err) => {
            reject(err);
        });
    });
}
