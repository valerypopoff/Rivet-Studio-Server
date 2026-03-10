import type { LatestWorkflowMatch, PublishedWorkflowMatch, StoredWorkflowProjectSettings, WorkflowProjectSettings, WorkflowProjectSettingsDraft, WorkflowProjectStatus } from './types.js';
export declare function getWorkflowProjectSettings(projectPath: string, projectName: string): Promise<WorkflowProjectSettings>;
export declare function readStoredWorkflowProjectSettings(projectPath: string, _projectName: string): Promise<StoredWorkflowProjectSettings>;
export declare function writeStoredWorkflowProjectSettings(projectPath: string, settings: StoredWorkflowProjectSettings): Promise<void>;
export declare function createDefaultStoredWorkflowProjectSettings(): StoredWorkflowProjectSettings;
export declare function normalizeWorkflowProjectSettingsDraft(value: unknown): WorkflowProjectSettingsDraft;
export declare function normalizeStoredWorkflowProjectSettings(value: unknown): StoredWorkflowProjectSettings;
export declare function getDerivedWorkflowProjectStatus(settings: StoredWorkflowProjectSettings, currentStateHash: string): WorkflowProjectStatus;
export declare function normalizeStoredEndpointName(value: string): string;
export declare function normalizeWorkflowEndpointLookupName(value: string): string;
export declare function isWorkflowEndpointPublished(settings: StoredWorkflowProjectSettings, endpointName: string): boolean;
export declare function ensureWorkflowEndpointNameIsUnique(root: string, currentProjectPath: string, endpointName: string): Promise<void>;
export declare function createWorkflowPublicationStateHash(projectPath: string, endpointName: string): Promise<string>;
export declare function writePublishedWorkflowSnapshot(root: string, projectPath: string, snapshotId: string): Promise<void>;
export declare function deletePublishedWorkflowSnapshot(root: string, snapshotId: string | null): Promise<void>;
export declare function resolvePublishedWorkflowProjectPath(root: string, projectPath: string, settings: StoredWorkflowProjectSettings): Promise<string | null>;
export declare function findPublishedWorkflowByEndpoint(root: string, endpointName: string): Promise<PublishedWorkflowMatch | null>;
export declare function findLatestWorkflowByEndpoint(root: string, endpointName: string): Promise<LatestWorkflowMatch | null>;
export declare function createPublishedWorkflowProjectReferenceLoader(root: string, rootProjectPath: string): {
    loadProject(currentProjectPath: string | undefined, reference: {
        id: string;
        hintPaths?: string[];
        title?: string;
    }): Promise<import("@ironclad/rivet-core").Project>;
};
