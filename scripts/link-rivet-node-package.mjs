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
const ironcladDir = path.join(apiNodeModulesDir, '@ironclad');

const packages = [
  {
    name: 'rivet-core',
    source: path.join(rivetRootDir, 'packages', 'core'),
  },
  {
    name: 'rivet-node',
    source: path.join(rivetRootDir, 'packages', 'node'),
  },
];

function ensurePackageReady(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const distIndexPath = path.join(pkg.source, 'dist', 'esm', 'index.js');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Expected ${pkg.name} package at ${pkg.source}`);
  }

  if (!fs.existsSync(distIndexPath)) {
    throw new Error(`Expected built ${pkg.name} ESM output at ${distIndexPath}`);
  }
}

function linkPackage(pkg) {
  ensurePackageReady(pkg);

  fs.mkdirSync(ironcladDir, { recursive: true });

  const destination = path.join(ironcladDir, pkg.name);
  fs.rmSync(destination, { recursive: true, force: true });

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(pkg.source, destination, symlinkType);
  console.log(`[link-rivet-node-package] @ironclad/${pkg.name} -> ${pkg.source}`);
}

for (const pkg of packages) {
  linkPackage(pkg);
}

// Node resolves symlink targets by their real path. When rivet/ is a local
// junction or checkout that does not use node-modules linking, the node package
// still needs its workspace dependency beside its real package path.
const nodePackageDependencyDir = path.join(packages[1].source, 'node_modules', '@ironclad');
fs.mkdirSync(nodePackageDependencyDir, { recursive: true });

const nodePackageCoreDependency = path.join(nodePackageDependencyDir, 'rivet-core');
fs.rmSync(nodePackageCoreDependency, { recursive: true, force: true });
fs.symlinkSync(packages[0].source, nodePackageCoreDependency, process.platform === 'win32' ? 'junction' : 'dir');
