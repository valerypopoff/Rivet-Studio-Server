import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvFile(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const withoutInlineComment = rawValue.trim().replace(/\s+#.*$/, '');
    const value = stripWrappingQuotes(withoutInlineComment)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r');

    entries.push([key, value]);
  }

  return entries;
}

function loadRootEnv(): void {
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '..', '..', '.env'),
    path.resolve(moduleDir, '..', '.env'),
    path.resolve(moduleDir, '..', '..', '.env'),
    path.resolve(moduleDir, '..', '..', '..', '.env'),
    path.resolve(moduleDir, '..', '..', '..', '..', '.env'),
  ];
  const rootEnvPath = candidatePaths.find((candidatePath, index) => {
    return candidatePaths.indexOf(candidatePath) === index && fs.existsSync(candidatePath);
  });

  if (!rootEnvPath) {
    return;
  }

  const envContent = fs.readFileSync(rootEnvPath, 'utf8');
  for (const [key, value] of parseEnvFile(envContent)) {
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

loadRootEnv();
