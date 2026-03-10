import { EventEmitter } from 'node:events';
export type JobStatus = 'queued' | 'running' | 'validating' | 'activating' | 'succeeded' | 'failed';
export type JobType = 'install' | 'remove';
export interface JobState {
    id: string;
    type: JobType;
    status: JobStatus;
    packages: Array<{
        name: string;
        version: string;
    }>;
    logs: string[];
    error?: string;
    createdAt: string;
    finishedAt?: string;
}
declare class JobRunner extends EventEmitter {
    private activeJob;
    private jobCounter;
    getActiveJob(): JobState | null;
    getJob(id: string): JobState | null;
    isRunning(): boolean;
    startInstall(packages: Array<{
        name: string;
        version: string;
    }>): JobState;
    startRemove(packageNames: string[]): JobState;
    private appendLog;
    private setStatus;
    private runInstall;
    private runRemove;
    private buildAndPromote;
    private npmInstall;
    private validateCandidate;
    private failJob;
}
export declare const jobRunner: JobRunner;
export {};
