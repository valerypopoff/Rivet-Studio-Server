import { deserializeProject, type Project } from '@ironclad/rivet-core';

export function deserializeProjectAsync(serializedProject: unknown): Promise<Project> {
  const [project] = deserializeProject(serializedProject);
  return Promise.resolve(project);
}
