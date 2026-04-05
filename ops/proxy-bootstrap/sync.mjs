import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import s3Pkg from '@aws-sdk/client-s3';
import smithyNodeHttpHandlerPkg from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'node:https';
import pg from 'pg';
import * as tar from 'tar';

import { getManagedRuntimeLibrariesConfig, getManagedRuntimeLibrariesPoolConfig } from './config.mjs';
import {
  currentDir,
  currentNodeModulesPath,
  ensureDirectories,
  jobsRoot,
  promoteCurrentRelease,
  readManifest,
  removeCurrentRelease,
  writeManifest,
} from './state.mjs';

const { S3Client, GetObjectCommand, HeadBucketCommand } = s3Pkg;
const { NodeHttpHandler } = smithyNodeHttpHandlerPkg;

function createS3Client(config) {
  const clientConfig = {
    region: config.objectStorageRegion,
    forcePathStyle: config.objectStorageForcePathStyle,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets: 16,
        keepAliveMsecs: 30_000,
      }),
    }),
    credentials: {
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
    },
  };

  if (config.objectStorageEndpoint) {
    clientConfig.endpoint = config.objectStorageEndpoint;
  }

  return new S3Client(clientConfig);
}

function normalizeBlobKey(key) {
  return key.replace(/^\/+/, '').replace(/\\/g, '/');
}

function prefixedBlobKey(prefix, key) {
  return `${prefix}${normalizeBlobKey(key)}`;
}

async function queryActiveRelease(pool) {
  const result = await pool.query(`
    SELECT r.release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256, r.created_at, a.updated_at
    FROM runtime_library_activation a
    LEFT JOIN runtime_library_releases r ON r.release_id = a.active_release_id
    WHERE a.slot = 'default'
  `);

  return result.rows[0] ?? null;
}

export function createManagedRuntimeLibrariesSyncController() {
  const config = getManagedRuntimeLibrariesConfig();
  if (!config.objectStorageBucket || !config.objectStorageAccessKeyId || !config.objectStorageSecretAccessKey) {
    throw new Error('Managed runtime-library sync requires object-storage bucket and credentials');
  }

  ensureDirectories();
  const pool = new pg.Pool(getManagedRuntimeLibrariesPoolConfig(config));
  const s3 = createS3Client(config);
  let syncPromise = null;
  let lastSyncCheckAt = 0;

  const syncCurrentRelease = async (force = false) => {
    if (syncPromise) {
      if (!force) {
        return syncPromise;
      }

      await syncPromise;
    }

    if (!force && Date.now() - lastSyncCheckAt < config.syncPollIntervalMs) {
      return;
    }

    const run = (async () => {
      const activeRelease = await queryActiveRelease(pool);
      const manifest = readManifest();
      const cachedReleaseId = manifest.activeReleaseId ?? null;
      const nextReleaseId = activeRelease?.release_id ?? null;
      const nextPackages = activeRelease?.packages_json && typeof activeRelease.packages_json === 'object'
        ? activeRelease.packages_json
        : {};

      if (!nextReleaseId) {
        if (cachedReleaseId || currentNodeModulesPath()) {
          removeCurrentRelease();
          writeManifest({ packages: {}, updatedAt: new Date().toISOString() });
        }
        lastSyncCheckAt = Date.now();
        return;
      }

      if (Object.keys(nextPackages).length === 0) {
        removeCurrentRelease();
        writeManifest({
          packages: {},
          updatedAt: activeRelease.updated_at ? new Date(activeRelease.updated_at).toISOString() : new Date().toISOString(),
          activeReleaseId: nextReleaseId,
        });
        lastSyncCheckAt = Date.now();
        return;
      }

      if (
        cachedReleaseId === nextReleaseId &&
        currentNodeModulesPath() &&
        fs.existsSync(path.join(currentDir(), 'package.json'))
      ) {
        lastSyncCheckAt = Date.now();
        return;
      }

      if (!activeRelease.artifact_blob_key) {
        throw new Error(`Active runtime-library release ${nextReleaseId} is missing its artifact pointer`);
      }

      const response = await s3.send(new GetObjectCommand({
        Bucket: config.objectStorageBucket,
        Key: prefixedBlobKey(config.objectStoragePrefix, activeRelease.artifact_blob_key),
      }));

      if (!response.Body) {
        throw new Error(`Object body missing for runtime-library artifact ${activeRelease.artifact_blob_key}`);
      }

      const archiveBuffer = Buffer.from(await response.Body.transformToByteArray());
      const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');
      if (activeRelease.artifact_sha256 && archiveSha256 !== activeRelease.artifact_sha256) {
        throw new Error(`Runtime-library artifact checksum mismatch for release ${nextReleaseId}`);
      }

      const tempRoot = fs.mkdtempSync(path.join(jobsRoot(), `sync-${nextReleaseId}-`));
      const archivePath = path.join(tempRoot, 'release.tar');
      const extractedDir = path.join(tempRoot, 'candidate');

      try {
        fs.mkdirSync(extractedDir, { recursive: true });
        fs.writeFileSync(archivePath, archiveBuffer);

        await tar.x({
          file: archivePath,
          cwd: extractedDir,
        });

        promoteCurrentRelease(extractedDir);
        writeManifest({
          packages: nextPackages,
          updatedAt: activeRelease.updated_at ? new Date(activeRelease.updated_at).toISOString() : new Date().toISOString(),
          activeReleaseId: nextReleaseId,
        });
        lastSyncCheckAt = Date.now();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    })();

    syncPromise = run.finally(() => {
      syncPromise = null;
    });

    return syncPromise;
  };

  return {
    config,
    syncCurrentRelease,
    async initialize() {
      await s3.send(new HeadBucketCommand({ Bucket: config.objectStorageBucket }));
      await syncCurrentRelease(true);
    },
    async dispose() {
      syncPromise = null;
      lastSyncCheckAt = 0;
      await pool.end().catch(() => {});
    },
  };
}
