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
const ironcladDir = path.join(apiNodeModulesDir, '@ironclad');
const rivetNodeModulesDir = path.join(rivetRootDir, 'node_modules');

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

  if (!fs.existsSync(rivetNodeModulesDir)) {
    throw new Error(`Expected Rivet dependencies at ${rivetNodeModulesDir}`);
  }
}

function linkDirectory(source, destination) {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.rmSync(destination, { recursive: true, force: true });
  fs.symlinkSync(source, destination, symlinkType);
}

function createPackageLinkTarget(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const packageLinkDir = path.join(packageLinksDir, pkg.name);

  fs.rmSync(packageLinkDir, { recursive: true, force: true });
  fs.mkdirSync(packageLinkDir, { recursive: true });
  fs.copyFileSync(packageJsonPath, path.join(packageLinkDir, 'package.json'));
  linkDirectory(path.join(pkg.source, 'dist'), path.join(packageLinkDir, 'dist'));
  linkDirectory(rivetNodeModulesDir, path.join(packageLinkDir, 'node_modules'));

  return packageLinkDir;
}

function linkPackage(pkg) {
  ensurePackageReady(pkg);

  fs.mkdirSync(ironcladDir, { recursive: true });

  const destination = path.join(ironcladDir, pkg.name);
  const packageLinkDir = createPackageLinkTarget(pkg);
  linkDirectory(packageLinkDir, destination);
  console.log(`[link-rivet-node-package] @ironclad/${pkg.name} -> ${packageLinkDir} (dist from ${pkg.source})`);
}

for (const pkg of packages) {
  linkPackage(pkg);
}
