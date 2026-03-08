import { Router } from 'express';
import { isShellAllowed, getCommandTimeout, getMaxOutputBytes, validatePath } from '../security.js';
import { execCommand } from '../utils/exec.js';
import { asyncHandler } from '../utils/asyncHandler.js';
export const shellRouter = Router();
// POST /api/shell/exec
shellRouter.post('/exec', asyncHandler(async (req, res) => {
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
    const result = await execCommand(program, args, { cwd, timeoutMs: timeout, maxOutputBytes: maxOutput });
    res.json(result);
}));
