// Override for rivet/packages/app/src/utils/tauri.ts
// Adds isHostedMode(), routes getEnvVar() through API backend

import { type RivetPlugin, type Settings, type StringPluginConfigurationSpec } from '@ironclad/rivet-core';
import { entries } from '../../../../rivet/packages/core/src/utils/typeSafety';
import type { EnvironmentProvider, PathPolicyProvider } from '../../../../rivet/packages/app/src/providers/ProvidersContext.js';
import { RIVET_API_BASE_URL, RIVET_HOSTED_MODE } from '../../../shared/hosted-env';

export function isInTauri(): boolean {
  return false;
}

export function isHostedMode(): boolean {
  return RIVET_HOSTED_MODE;
}

const cachedEnvVars: Record<string, string> = {};

export function getDefaultEnvironmentProvider(): EnvironmentProvider {
  return {
    getEnvVar,
  };
}

export function getDefaultPathPolicyProvider(): PathPolicyProvider {
  return {
    allowDataFileNeighbor,
    async readRelativeProjectFile(currentProjectPath, projectFilePath) {
      const response = await fetch(`${RIVET_API_BASE_URL}/native/read-relative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativeFrom: currentProjectPath,
          projectFilePath,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to read relative project file: ${response.status} ${response.statusText}`);
      }

      const { contents } = await response.json() as { contents: string };
      return contents;
    },
  };
}

export async function getEnvVar(name: string): Promise<string | undefined> {
  if (cachedEnvVars[name]) {
    return cachedEnvVars[name];
  }

  if (isHostedMode()) {
    try {
      const response = await fetch(`${RIVET_API_BASE_URL}/config/env/${encodeURIComponent(name)}`);
      if (!response.ok) {
        return undefined;
      }

      const { value } = await response.json() as { value?: string };
      if (value) {
        cachedEnvVars[name] = value;
      }
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  if (typeof process !== 'undefined') {
    return process.env[name];
  }

  return undefined;
}

export async function fillMissingSettingsFromEnvironmentVariables(
  settings: Partial<Settings>,
  plugins: RivetPlugin[],
  optionsOrExtraEnvVarNames: string[] | { extraEnvVarNames?: string[]; environmentProvider?: EnvironmentProvider } = [],
) {
  const options = Array.isArray(optionsOrExtraEnvVarNames)
    ? { extraEnvVarNames: optionsOrExtraEnvVarNames }
    : optionsOrExtraEnvVarNames;
  const environmentProvider = options.environmentProvider ?? getDefaultEnvironmentProvider();
  const getProviderEnvVar = (name: string) => environmentProvider.getEnvVar(name);
  const fullSettings: Settings = {
    ...settings,
    openAiKey: (settings.openAiKey || (await getProviderEnvVar('OPENAI_API_KEY'))) ?? '',
    openAiOrganization: (settings.openAiOrganization || (await getProviderEnvVar('OPENAI_ORG_ID'))) ?? '',
    openAiEndpoint: (settings.openAiEndpoint || (await getProviderEnvVar('OPENAI_ENDPOINT'))) ?? '',
    pluginSettings: settings.pluginSettings,
    pluginEnv: {},
  };

  for (const plugin of plugins) {
    const stringConfigs = entries(plugin.configSpec ?? {}).filter(([, c]) => c.type === 'string') as [
      string,
      StringPluginConfigurationSpec,
    ][];
    for (const [configName, config] of stringConfigs) {
      if (config.pullEnvironmentVariable) {
        const envVarName =
          typeof config.pullEnvironmentVariable === 'string'
            ? config.pullEnvironmentVariable
            : config.pullEnvironmentVariable === true
              ? configName
              : undefined;
        if (envVarName) {
          const envVarValue = await getProviderEnvVar(envVarName);
          if (envVarValue) {
            fullSettings.pluginEnv![envVarName] = envVarValue;
          }
        }
      }
    }
  }

  for (const envVarName of new Set((options.extraEnvVarNames ?? []).map((name) => name.trim()).filter(Boolean))) {
    const envVarValue = await getProviderEnvVar(envVarName);
    if (envVarValue) {
      fullSettings.pluginEnv![envVarName] = envVarValue;
    }
  }

  return fullSettings;
}

export async function allowDataFileNeighbor(projectFilePath: string): Promise<void> {
  if (isHostedMode()) {
    return;
  }

  void projectFilePath;
}
