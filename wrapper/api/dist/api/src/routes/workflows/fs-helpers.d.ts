export declare const PROJECT_EXTENSION = ".rivet-project";
export declare const PROJECT_SETTINGS_SUFFIX = ".wrapper-settings.json";
export declare const PUBLISHED_SNAPSHOTS_DIR = ".published";
export declare const WORKFLOW_DATASET_SUFFIX = ".rivet-data";
export declare function ensureWorkflowsRoot(): Promise<string>;
export declare function sanitizeWorkflowName(value: unknown, label: string): string;
export declare function resolveWorkflowRelativePath(root: string, relativePath: unknown, options: {
    allowProjectFile: boolean;
    allowEmpty?: boolean;
}): string;
export declare function pathExists(filePath: string): Promise<boolean>;
export declare function getWorkflowProjectSettingsPath(projectPath: string): string;
export declare function getPublishedSnapshotsRoot(root: string): string;
export declare function getPublishedWorkflowSnapshotPath(root: string, snapshotId: string): string;
export declare function getPublishedWorkflowSnapshotDatasetPath(root: string, snapshotId: string): string;
export declare function getWorkflowDatasetPath(projectPath: string): string;
export declare function getProjectSidecarPaths(projectPath: string): {
    dataset: string;
    settings: string;
};
export declare function listProjectPathsRecursive(folderPath: string): Promise<string[]>;
export declare function quoteForYaml(value: string): string;
export declare function createBlankProjectFile(projectName: string): string;
