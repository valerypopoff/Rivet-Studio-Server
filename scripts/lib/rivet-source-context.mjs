import fs from 'node:fs';
import path from 'node:path';

const contextRootRelPath = path.join('.data', 'docker-contexts');
const defaultContextRelPath = path.join(contextRootRelPath, 'rivet-source');

const rootFiles = [
  '.editorconfig',
  '.gitattributes',
  '.npmignore',
  '.prettierrc.yml',
  '.yarnrc.yml',
  'LICENSE',
  'README.md',
  'eslint.config.mjs',
  'package.json',
  'tsconfig.base.json',
  'yarn.lock',
];

const yarnSubdirectories = ['releases', 'patches', 'plugins'];

const excludedDirectoryNames = new Set([
  '.cache',
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'sidecars',
  'src-tauri',
]);

const excludedFileNames = new Set([
  '.pnp.cjs',
  '.pnp.loader.mjs',
  'install-state.gz',
  'stats.html',
  'tsconfig.tsbuildinfo',
]);

export function getDefaultRivetDockerContextPath(rootDir) {
  return path.join(rootDir, defaultContextRelPath);
}

function assertInside(parentDir, childPath, label) {
  const relative = path.relative(parentDir, childPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[rivet-context] Refusing to use ${label} outside ${parentDir}: ${childPath}`);
  }
}

function copyFiltered(sourcePath, destinationPath) {
  fs.cpSync(sourcePath, destinationPath, {
    dereference: false,
    errorOnExist: false,
    filter: (candidate) => {
      const name = path.basename(candidate);
      const stats = fs.lstatSync(candidate);

      if (stats.isDirectory()) {
        return !excludedDirectoryNames.has(name);
      }

      return !excludedFileNames.has(name);
    },
    force: true,
    recursive: true,
  });
}

function copyIfExists(sourceRoot, destinationRoot, relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);

  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const destinationPath = path.join(destinationRoot, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFiltered(sourcePath, destinationPath);
  return true;
}

function validateRivetSource(sourceRoot) {
  const requiredPaths = [
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    path.join('.yarn', 'releases'),
    path.join('packages', 'core', 'package.json'),
    path.join('packages', 'node', 'package.json'),
  ];

  for (const relativePath of requiredPaths) {
    const candidate = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(candidate)) {
      throw new Error(`[rivet-context] Expected upstream Rivet source file or directory at ${candidate}`);
    }
  }
}

export function prepareRivetDockerContext(rootDir, env) {
  const sourceRoot = fs.realpathSync.native(String(env.RIVET_SOURCE_HOST_PATH ?? path.join(rootDir, 'rivet')));
  const contextRoot = path.join(rootDir, contextRootRelPath);
  const contextPath = path.resolve(String(env.RIVET_SOURCE_BUILD_CONTEXT_PATH ?? getDefaultRivetDockerContextPath(rootDir)));

  assertInside(contextRoot, contextPath, 'Rivet Docker build context');
  validateRivetSource(sourceRoot);

  fs.rmSync(contextPath, { recursive: true, force: true });
  fs.mkdirSync(contextPath, { recursive: true });

  for (const relativePath of rootFiles) {
    copyIfExists(sourceRoot, contextPath, relativePath);
  }

  copyIfExists(sourceRoot, contextPath, 'packages');

  for (const subdirectory of yarnSubdirectories) {
    copyIfExists(sourceRoot, contextPath, path.join('.yarn', subdirectory));
  }

  env.RIVET_SOURCE_BUILD_CONTEXT_PATH = contextPath;

  console.log(`[rivet-context] Prepared filtered Rivet Docker context: ${contextPath}`);
  console.log(`[rivet-context] Source: ${sourceRoot}`);
  console.log('[rivet-context] Excluded dependency folders, build output, VCS data, and Yarn cache artifacts.');

  return contextPath;
}
