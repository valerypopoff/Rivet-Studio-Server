import fs from 'node:fs/promises';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import type { WorkflowProjectStats } from './types.js';

function emptyWorkflowProjectStats(): WorkflowProjectStats {
  return {
    graphCount: 0,
    totalNodeCount: 0,
  };
}

export function getWorkflowProjectStatsFromContents(contents: string): WorkflowProjectStats {
  try {
    const project = loadProjectFromString(contents);
    const graphs = Object.values(project.graphs ?? {});

    return {
      graphCount: graphs.length,
      totalNodeCount: graphs.reduce((count, graph) => {
        const nodes = graph.nodes as unknown;
        if (Array.isArray(nodes)) {
          return count + nodes.length;
        }

        if (nodes != null && typeof nodes === 'object') {
          return count + Object.keys(nodes).length;
        }

        return count;
      }, 0),
    };
  } catch {
    return emptyWorkflowProjectStats();
  }
}

export async function getWorkflowProjectStatsFromFile(filePath: string): Promise<WorkflowProjectStats> {
  try {
    return getWorkflowProjectStatsFromContents(await fs.readFile(filePath, 'utf8'));
  } catch {
    return emptyWorkflowProjectStats();
  }
}
