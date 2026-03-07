import { useEffect, useMemo, useState, type FC } from 'react';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import FileIcon from 'majesticons/line/file-line.svg?react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import ExpandLeftIcon from 'majesticons/line/menu-expand-left-line.svg?react';
import { toast } from 'react-toastify';
import { createWorkflowFolder, createWorkflowProject, fetchWorkflowTree, renameWorkflowFolder } from './workflowApi';
import type { WorkflowFolderItem, WorkflowProjectItem } from './types';

const styles = `
  .workflow-library-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    color: var(--grey-light);
  }

  .workflow-library-panel .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--grey);
    min-height: 44px;
  }

  .workflow-library-panel .header-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--grey-lightest);
  }

  .workflow-library-panel .header-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .workflow-library-panel .icon-button,
  .workflow-library-panel .text-button {
    border: none;
    cursor: pointer;
    color: var(--grey-lightest);
    background: rgba(255, 255, 255, 0.06);
    transition: background 120ms ease, opacity 120ms ease;
  }

  .workflow-library-panel .icon-button {
    min-width: 28px;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
  }

  .workflow-library-panel .text-button {
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
  }

  .workflow-library-panel .icon-button:hover,
  .workflow-library-panel .text-button:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .workflow-library-panel .body {
    position: relative;
    flex: 1;
    overflow: auto;
    padding: 8px 8px 16px 8px;
  }

  .workflow-library-panel .body-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 8px 4px;
  }

  .workflow-library-panel .body-status {
    font-size: 11px;
    color: var(--grey-light);
  }

  .workflow-library-panel .link-button {
    border: none;
    background: transparent;
    padding: 0;
    color: var(--grey-lightest);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .workflow-library-panel .link-button:hover {
    text-decoration: underline;
  }

  .workflow-library-panel .state {
    padding: 12px;
    font-size: 12px;
    color: var(--grey-light);
  }

  .workflow-library-panel .folder {
    margin-bottom: 6px;
  }

  .workflow-library-panel .folder-row,
  .workflow-library-panel .project-row {
    width: 100%;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    text-align: left;
  }

  .workflow-library-panel .folder-row {
    justify-content: space-between;
  }

  .workflow-library-panel .folder-row:hover,
  .workflow-library-panel .project-row:hover,
  .workflow-library-panel .folder-row.active,
  .workflow-library-panel .project-row.active {
    background: rgba(255, 255, 255, 0.08);
  }

  .workflow-library-panel .folder-toggle {
    border: none;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    padding: 0;
    cursor: pointer;
    justify-content: center;
    width: 20px;
    min-width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .workflow-library-panel .folder-toggle:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .workflow-library-panel .folder-content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
  }

  .workflow-library-panel .folder-name-button {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    cursor: default;
    text-align: left;
  }

  .workflow-library-panel .folder-main,
  .workflow-library-panel .project-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .workflow-library-panel .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .workflow-library-panel .folder-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0.8;
  }

  .workflow-library-panel .projects {
    margin-top: 2px;
    margin-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .workflow-library-panel .project-row {
    padding-left: 28px;
    font-size: 12px;
  }

  .workflow-library-panel .project-row {
    border: none;
    cursor: pointer;
  }
`;

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: { replaceCurrent?: boolean }) => void;
  onSaveProject: () => void;
  activeProjectPath: string;
  editorReady: boolean;
  onCollapse?: () => void;
}

export const WorkflowLibraryPanel: FC<WorkflowLibraryPanelProps> = ({
  onOpenProject,
  onSaveProject,
  activeProjectPath,
  editorReady,
  onCollapse,
}) => {
  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    setLoading(true);
    setError(null);

    try {
      const tree = await fetchWorkflowTree();
      setFolders(tree.folders);
      setRootProjects(tree.projects);
      setExpandedFolders((prev) => {
        const next = { ...prev };
        for (const folder of tree.folders) {
          if (next[folder.id] == null) {
            next[folder.id] = true;
          }
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load workflow folders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const activePath = activeProjectPath;

  const folderIds = useMemo(() => folders.map((folder) => folder.id), [folders]);

  const renderProjectRow = (project: WorkflowProjectItem, indentClassName = '') => (
    <button
      key={project.id}
      className={`project-row${indentClassName ? ` ${indentClassName}` : ''}${activePath === project.absolutePath ? ' active' : ''}`}
      disabled={!editorReady}
      onClick={() => void handleOpenProject(project.absolutePath)}
      onDoubleClick={() => void handleSwitchProject(project.absolutePath)}
      title={editorReady ? project.fileName : 'Loading editor...'}
    >
      <div className="project-main">
        <FileIcon />
        <div className="label">{project.name}</div>
      </div>
    </button>
  );

  const handleCreateFolder = async () => {
    const name = prompt('New folder name:');
    if (!name) {
      return;
    }

    try {
      const folder = await createWorkflowFolder(name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create folder');
    }
  };

  const handleRenameFolder = async (folder: WorkflowFolderItem) => {
    const newName = prompt('Rename folder:', folder.name);
    if (!newName || newName === folder.name) {
      return;
    }

    try {
      await renameWorkflowFolder(folder.relativePath, newName);
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename folder');
    }
  };

  const handleAddProject = async (folder: WorkflowFolderItem) => {
    const name = prompt(`New Rivet project name for ${folder.name}:`);
    if (!name) {
      return;
    }

    try {
      const project = await createWorkflowProject(folder.relativePath, name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh();
      onOpenProject(project.absolutePath);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create project');
    }
  };

  const handleOpenProject = (absolutePath: string) => {
    onOpenProject(absolutePath);
  };

  const handleSwitchProject = (absolutePath: string) => {
    onOpenProject(absolutePath, { replaceCurrent: true });
  };

  return (
    <div className="workflow-library-panel">
      <style>{styles}</style>
      <div className="header">
        <div className="header-title">Projects</div>
        <div className="header-actions">
          {activeProjectPath ? (
            <button
              type="button"
              className="text-button"
              disabled={!editorReady}
              onClick={onSaveProject}
              title={editorReady ? 'Save current project' : 'Loading editor...'}
              aria-label={editorReady ? 'Save current project' : 'Loading editor'}
            >
              Save
            </button>
          ) : null}
          {onCollapse ? (
            <button
              type="button"
              className="icon-button"
              onClick={onCollapse}
              title="Collapse folders pane"
              aria-label="Collapse folders pane"
            >
              <ExpandLeftIcon />
            </button>
          ) : null}
        </div>
      </div>

      <div className="body">
        <div className="body-actions">
          <button type="button" className="link-button" onClick={() => void handleCreateFolder()}>
            + New folder
          </button>
          {!editorReady ? <div className="body-status">Loading editor...</div> : null}
        </div>
        {loading ? <div className="state">Loading folders...</div> : null}
        {!loading && error ? <div className="state">{error}</div> : null}
        {!loading && !error && folderIds.length === 0 && rootProjects.length === 0 ? (
          <div className="state">No workflow projects yet. Use + New folder to create the first folder.</div>
        ) : null}

        {!loading && !error && rootProjects.length > 0 ? <div className="projects">{rootProjects.map((project) => renderProjectRow(project))}</div> : null}

        {!loading && !error
          ? folders.map((folder) => {
              const expanded = expandedFolders[folder.id] ?? true;

              return (
                <div className="folder" key={folder.id}>
                  <div
                    className="folder-row"
                  >
                    <button
                      type="button"
                      className="folder-toggle"
                      onClick={() => setExpandedFolders((prev) => ({ ...prev, [folder.id]: !expanded }))}
                      title={folder.name}
                      aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
                    >
                      {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    </button>
                    <div className="folder-content">
                      <button
                        type="button"
                        className="folder-name-button"
                        onDoubleClick={() => void handleRenameFolder(folder)}
                        title={folder.name}
                      >
                        <div className="folder-main">
                          <FolderIcon />
                          <div className="label">{folder.name}</div>
                        </div>
                      </button>
                    </div>
                    <div className="folder-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void handleAddProject(folder)}
                        title={`Create project in ${folder.name}`}
                        aria-label={`Create project in ${folder.name}`}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {expanded ? (
                    <div className="projects">
                      {folder.projects.length === 0 ? <div className="state">No Rivet projects in this folder.</div> : null}
                      {folder.projects.map((project) => renderProjectRow(project))}
                    </div>
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
};
