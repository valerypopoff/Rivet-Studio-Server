import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const rivetRootDir = process.env.RIVET_SOURCE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_SOURCE_ROOT)
  : path.join(rootDir, 'rivet');
const apiPackageDir = process.env.RIVET_API_PACKAGE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_API_PACKAGE_ROOT)
  : path.join(rootDir, 'wrapper', 'api');
const apiNodeModulesDir = path.join(apiPackageDir, 'node_modules');
const packageLinksDir = path.join(apiNodeModulesDir, '.rivet-package-links');
const rivetNodeModulesDir = path.join(rivetRootDir, 'node_modules');
const retiredScope = ['@', 'iron', 'clad'].join('');
const retiredPackageAliases = [
  { scope: retiredScope, name: 'rivet-core' },
  { scope: retiredScope, name: 'rivet-node' },
];

const packages = [
  {
    linkName: 'rivet-core',
    source: path.join(rivetRootDir, 'packages', 'core'),
    aliases: [
      { scope: '@rivet2', name: 'rivet-core' },
    ],
  },
  {
    linkName: 'rivet-node',
    source: path.join(rivetRootDir, 'packages', 'node'),
    aliases: [
      { scope: '@rivet2', name: 'rivet-node' },
    ],
  },
];

function readPackageJson(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function parsePackageName(packageName) {
  const match = /^(@[^/]+)\/(.+)$/.exec(packageName);

  if (!match) {
    throw new Error(`Expected scoped Rivet package name, got ${packageName}`);
  }

  return { scope: match[1], name: match[2] };
}

function uniqueAliases(aliases) {
  const seen = new Set();
  return aliases.filter((alias) => {
    const key = `${alias.scope}/${alias.name}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function packageNameToNodeModulesPath(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(scope, name);
  }

  return packageName;
}

function collectRuntimeDependencyNames() {
  const dependencyNames = new Set();

  for (const pkg of packages) {
    const packageJson = readPackageJson(pkg);

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  return [...dependencyNames];
}

function ensurePackageReady(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const distIndexPath = path.join(pkg.source, 'dist', 'esm', 'index.js');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Expected ${pkg.linkName} package at ${pkg.source}`);
  }

  if (!fs.existsSync(distIndexPath)) {
    throw new Error(`Expected built ${pkg.linkName} ESM output at ${distIndexPath}`);
  }

  if (!fs.existsSync(rivetNodeModulesDir)) {
    throw new Error(`Expected Rivet dependencies at ${rivetNodeModulesDir}`);
  }
}

function ensureRivetNodeModulesReady() {
  const missingDependencies = collectRuntimeDependencyNames().filter((dependencyName) => {
    const dependencyPath = path.join(rivetNodeModulesDir, packageNameToNodeModulesPath(dependencyName));
    return !fs.existsSync(dependencyPath);
  });

  if (missingDependencies.length > 0) {
    throw new Error(
      [
        `Expected Rivet node-modules install at ${rivetNodeModulesDir}.`,
        `Missing: ${missingDependencies.slice(0, 8).join(', ')}${missingDependencies.length > 8 ? ', ...' : ''}.`,
        'Run npm run setup so the embedded Rivet checkout is installed with YARN_NODE_LINKER=node-modules.',
      ].join(' '),
    );
  }
}

function linkDirectory(source, destination) {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.rmSync(destination, { recursive: true, force: true });
  fs.symlinkSync(source, destination, symlinkType);
}

function removeRetiredPackageAliases() {
  const touchedScopes = new Set();

  for (const alias of retiredPackageAliases) {
    const scopeDir = path.join(apiNodeModulesDir, alias.scope);
    fs.rmSync(path.join(scopeDir, alias.name), { recursive: true, force: true });
    touchedScopes.add(scopeDir);
  }

  for (const scopeDir of touchedScopes) {
    try {
      if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } catch {
      // Best effort cleanup only; package linking below is the required step.
    }
  }
}

function createPackageLinkTarget(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const packageLinkDir = path.join(packageLinksDir, pkg.linkName);

  fs.rmSync(packageLinkDir, { recursive: true, force: true });
  fs.mkdirSync(packageLinkDir, { recursive: true });
  fs.copyFileSync(packageJsonPath, path.join(packageLinkDir, 'package.json'));
  linkDirectory(path.join(pkg.source, 'dist'), path.join(packageLinkDir, 'dist'));
  linkDirectory(rivetNodeModulesDir, path.join(packageLinkDir, 'node_modules'));

  return packageLinkDir;
}

function linkPackage(pkg) {
  ensurePackageReady(pkg);

  const packageJson = readPackageJson(pkg);
  const packageLinkDir = createPackageLinkTarget(pkg);
  const aliases = uniqueAliases([...pkg.aliases, parsePackageName(packageJson.name)]);

  for (const alias of aliases) {
    const scopeDir = path.join(apiNodeModulesDir, alias.scope);
    const destination = path.join(scopeDir, alias.name);

    fs.mkdirSync(scopeDir, { recursive: true });
    linkDirectory(packageLinkDir, destination);
    console.log(`[link-rivet-node-package] ${alias.scope}/${alias.name} -> ${packageLinkDir} (dist from ${pkg.source})`);
  }
}

removeRetiredPackageAliases();
ensureRivetNodeModulesReady();

for (const pkg of packages) {
  linkPackage(pkg);
}
