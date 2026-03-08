// Override for rivet/packages/app/src/model/TauriProjectReferenceLoader.ts
// Uses API-backed invoke to read relative project files

import { type ProjectReference, type Project, deserializeProject } from '@ironclad/rivet-core';
import { type ProjectReferenceLoader } from '../../../../rivet/packages/core/src/model/ProjectReferenceLoader';
import { RIVET_API_BASE_URL } from '../../../shared/hosted-env';

export class TauriProjectReferenceLoader implements ProjectReferenceLoader {
  async loadProject(currentProjectPath: string | undefined, reference: ProjectReference): Promise<Project> {
    if (currentProjectPath === undefined) {
      throw new Error(
        `Could not load project "${reference.title} (${reference.id})": current project path is undefined.`,
      );
    }

    for (const path of reference.hintPaths ?? []) {
      try {
        const response = await fetch(`${RIVET_API_BASE_URL}/native/read-relative`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relativeFrom: currentProjectPath,
            projectFilePath: path,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to read relative project file: ${response.status} ${response.statusText}`);
        }

        const { contents: projectData } = await response.json() as { contents: string };

        const [project, attachedData] = deserializeProject(projectData);
        void attachedData;
        return project;
      } catch (err) {
        console.error(`Failed to load project "${reference.title} (${reference.id})" from path "${path}":`, err);
      }
    }

    throw new Error(
      `Could not load project "${reference.title} (${reference.id})": all hint paths failed. Tried: ${reference.hintPaths}`,
    );
  }
}
