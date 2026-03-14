import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'rivet');
const upstreamRepo = 'https://github.com/Ironclad/rivet.git';
const metadataFile = '.upstream-version';

function run(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const stdio = options.stdio ?? 'pipe';

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}\n${stderr}`.trim()));
    });
  });
}

function parseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) {
    return null;
  }

  return match.slice(1).map((segment) => parseInt(segment, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

async function resolveLatestStableTag() {
  const { stdout } = await run('git', ['ls-remote', '--tags', '--refs', upstreamRepo]);
  const matches = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commit, ref] = line.split(/\s+/);
      const tag = ref?.replace('refs/tags/', '');
      const version = tag == null ? null : parseVersion(tag);

      if (!commit || !tag || !version) {
        return null;
      }

      return { commit, tag, version };
    })
    .filter(Boolean);

  if (matches.length === 0) {
    throw new Error('No stable Rivet tags matching v<major>.<minor>.<patch> were found.');
  }

  matches.sort((left, right) => compareVersions(left.version, right.version));
  return matches[matches.length - 1];
}

function isDirectoryEmpty(dirPath) {
  return fs.readdirSync(dirPath).length === 0;
}

function removeTargetDir() {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function ensureTargetDirReady(force) {
  if (!fs.existsSync(targetDir)) {
    return;
  }

  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    throw new Error(`Expected ${targetDir} to be a directory.`);
  }

  if (isDirectoryEmpty(targetDir)) {
    return;
  }

  if (!force) {
    throw new Error(`The rivet directory already exists and is not empty. Remove it first or rerun with --force.`);
  }

  removeTargetDir();
}

async function cloneTag(tag) {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-bootstrap-'));
  const tempCloneDir = path.join(tempParent, 'rivet');

  try {
    console.log(`[setup:rivet] Downloading ${tag} from ${upstreamRepo}...`);
    await run('git', ['clone', '--depth', '1', '--branch', tag, upstreamRepo, tempCloneDir], { stdio: 'inherit' });

    fs.rmSync(path.join(tempCloneDir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tempCloneDir, metadataFile),
      JSON.stringify({ repo: upstreamRepo, tag }, null, 2) + '\n',
      'utf8',
    );

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(tempCloneDir, targetDir, { recursive: true });
  } catch (error) {
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}

async function main() {
  const force = process.argv.includes('--force');

  try {
    await run('git', ['--version']);
  } catch {
    throw new Error('Git is required to download the upstream Rivet source.');
  }

  ensureTargetDirReady(force);

  const latest = await resolveLatestStableTag();
  console.log(`[setup:rivet] Latest stable Rivet tag: ${latest.tag} (${latest.commit.slice(0, 7)})`);

  await cloneTag(latest.tag);

  console.log(`[setup:rivet] Rivet source downloaded to ${targetDir}`);
  console.log('[setup:rivet] You can now run npm run prod');
}

main().catch((error) => {
  console.error(`[setup:rivet] ${error.message}`);
  process.exit(1);
});
