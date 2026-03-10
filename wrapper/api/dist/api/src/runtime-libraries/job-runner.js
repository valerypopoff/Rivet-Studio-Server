import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { ensureDirectories, nextReleaseId, readManifest, releasesDir, stagingDir, writeActiveRelease, writeManifest, } from './manifest.js';
import { execStreaming } from '../utils/exec.js';
class JobRunner extends EventEmitter {
    activeJob = null;
    jobCounter = 0;
    getActiveJob() {
        return this.activeJob;
    }
    getJob(id) {
        if (this.activeJob?.id === id) {
            return this.activeJob;
        }
        return null;
    }
    isRunning() {
        return this.activeJob != null &&
            this.activeJob.status !== 'succeeded' &&
            this.activeJob.status !== 'failed';
    }
    startInstall(packages) {
        if (this.isRunning()) {
            throw new Error('A job is already running');
        }
        const job = {
            id: String(++this.jobCounter),
            type: 'install',
            status: 'queued',
            packages,
            logs: [],
            createdAt: new Date().toISOString(),
        };
        this.activeJob = job;
        void this.runInstall(job);
        return job;
    }
    startRemove(packageNames) {
        if (this.isRunning()) {
            throw new Error('A job is already running');
        }
        const job = {
            id: String(++this.jobCounter),
            type: 'remove',
            status: 'queued',
            packages: packageNames.map((name) => ({ name, version: '' })),
            logs: [],
            createdAt: new Date().toISOString(),
        };
        this.activeJob = job;
        void this.runRemove(job);
        return job;
    }
    appendLog(job, message) {
        job.logs.push(message);
        this.emit('log', job.id, message);
    }
    setStatus(job, status) {
        job.status = status;
        this.emit('status', job.id, status);
    }
    async runInstall(job) {
        try {
            ensureDirectories();
            this.setStatus(job, 'running');
            this.appendLog(job, '--- Starting install job ---');
            const manifest = readManifest();
            const candidatePackages = { ...manifest.packages };
            for (const pkg of job.packages) {
                candidatePackages[pkg.name] = {
                    name: pkg.name,
                    version: pkg.version,
                    installedAt: new Date().toISOString(),
                };
                this.appendLog(job, `Adding: ${pkg.name}@${pkg.version}`);
            }
            await this.buildAndPromote(job, manifest, candidatePackages);
        }
        catch (err) {
            this.failJob(job, err);
        }
    }
    async runRemove(job) {
        try {
            ensureDirectories();
            this.setStatus(job, 'running');
            this.appendLog(job, '--- Starting remove job ---');
            const manifest = readManifest();
            const candidatePackages = { ...manifest.packages };
            for (const pkg of job.packages) {
                if (!(pkg.name in candidatePackages)) {
                    this.appendLog(job, `Warning: ${pkg.name} is not installed, skipping`);
                    continue;
                }
                delete candidatePackages[pkg.name];
                this.appendLog(job, `Removing: ${pkg.name}`);
            }
            await this.buildAndPromote(job, manifest, candidatePackages);
        }
        catch (err) {
            this.failJob(job, err);
        }
    }
    async buildAndPromote(job, manifest, candidatePackages) {
        const staging = stagingDir();
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        const dependencies = {};
        for (const entry of Object.values(candidatePackages)) {
            dependencies[entry.name] = entry.version;
        }
        const packageJson = {
            name: 'rivet-runtime-libraries',
            private: true,
            version: '1.0.0',
            description: 'Managed runtime libraries for Rivet code nodes',
            dependencies,
        };
        fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
        this.appendLog(job, `Generated package.json with ${Object.keys(dependencies).length} dependencies`);
        if (Object.keys(dependencies).length === 0) {
            this.appendLog(job, 'No dependencies to install, creating empty release');
            fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
        }
        else {
            this.appendLog(job, 'Running npm install...');
            const exitCode = await this.npmInstall(job, staging);
            if (exitCode !== 0) {
                this.failJob(job, new Error(`npm install failed with exit code ${exitCode}`));
                return;
            }
            this.appendLog(job, 'npm install completed successfully');
        }
        this.setStatus(job, 'validating');
        this.appendLog(job, 'Validating installed packages...');
        const validationErrors = this.validateCandidate(staging, candidatePackages);
        if (validationErrors.length > 0) {
            for (const err of validationErrors) {
                this.appendLog(job, `Validation error: ${err}`);
            }
            this.failJob(job, new Error(`Validation failed: ${validationErrors.join('; ')}`));
            return;
        }
        this.appendLog(job, 'Validation passed');
        this.setStatus(job, 'activating');
        const releaseId = nextReleaseId();
        const releasePath = path.join(releasesDir(), releaseId);
        this.appendLog(job, `Promoting to release ${releaseId}...`);
        fs.renameSync(staging, releasePath);
        writeActiveRelease(releaseId);
        manifest.packages = candidatePackages;
        manifest.activeRelease = releaseId;
        manifest.lastSuccessfulRelease = releaseId;
        writeManifest(manifest);
        this.appendLog(job, `Release ${releaseId} is now active`);
        this.appendLog(job, '--- Job completed successfully ---');
        this.setStatus(job, 'succeeded');
        job.finishedAt = new Date().toISOString();
    }
    npmInstall(job, cwd) {
        return new Promise((resolve) => {
            const child = execStreaming('npm', ['install', '--production', '--no-audit', '--no-fund'], {
                cwd,
                timeoutMs: 300_000,
            });
            child.on('data', (_source, data) => {
                const lines = data.split('\n').filter((line) => line.trim());
                for (const line of lines) {
                    this.appendLog(job, line);
                }
            });
            child.on('exit', (code) => {
                resolve(code);
            });
            child.on('error', (err) => {
                this.appendLog(job, `Process error: ${err.message}`);
                resolve(1);
            });
        });
    }
    validateCandidate(candidateDir, packages) {
        const packageNames = Object.keys(packages);
        if (packageNames.length === 0) {
            return [];
        }
        const nodeModulesPath = path.join(candidateDir, 'node_modules');
        if (!fs.existsSync(nodeModulesPath)) {
            return ['node_modules directory not found'];
        }
        const errors = [];
        const virtualEntry = path.join(nodeModulesPath, '__validate.cjs');
        try {
            const req = createRequire(virtualEntry);
            for (const name of packageNames) {
                try {
                    req.resolve(name);
                }
                catch {
                    errors.push(`Package "${name}" could not be resolved from the candidate release`);
                }
            }
        }
        catch (err) {
            errors.push(`createRequire failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return errors;
    }
    failJob(job, err) {
        const message = err instanceof Error ? err.message : String(err);
        job.error = message;
        job.finishedAt = new Date().toISOString();
        this.appendLog(job, `ERROR: ${message}`);
        this.appendLog(job, '--- Job failed ---');
        this.setStatus(job, 'failed');
        try {
            fs.rmSync(stagingDir(), { recursive: true, force: true });
        }
        catch {
            // ignore cleanup errors
        }
    }
}
export const jobRunner = new JobRunner();
