import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectPathMove } from './types.js';
export declare function listWorkflowFolders(root: string): Promise<WorkflowFolderItem[]>;
export declare function listWorkflowProjects(root: string): Promise<WorkflowProjectItem[]>;
export declare function getWorkflowFolder(root: string, folderPath: string): Promise<WorkflowFolderItem>;
export declare function getWorkflowProject(root: string, filePath: string): Promise<WorkflowProjectItem>;
export declare function moveWorkflowProject(root: string, sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{
    project: WorkflowProjectItem;
    movedProjectPaths: WorkflowProjectPathMove[];
}>;
export declare function moveWorkflowFolder(root: string, sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{
    folder: WorkflowFolderItem;
    movedProjectPaths: WorkflowProjectPathMove[];
}>;
