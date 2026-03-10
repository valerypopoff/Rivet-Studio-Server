export interface RuntimeLibraryEntry {
    name: string;
    version: string;
    installedAt?: string;
}
export interface RuntimeLibraryManifest {
    packages: Record<string, RuntimeLibraryEntry>;
    activeRelease: string | null;
    lastSuccessfulRelease: string | null;
    updatedAt: string;
}
export declare function getRootPath(): string;
export declare function releasesDir(): string;
export declare function stagingDir(): string;
export declare function ensureDirectories(): void;
export declare function emptyManifest(): RuntimeLibraryManifest;
export declare function readManifest(): RuntimeLibraryManifest;
export declare function writeManifest(manifest: RuntimeLibraryManifest): void;
export declare function readActiveRelease(): string | null;
export declare function writeActiveRelease(releaseId: string): void;
export declare function nextReleaseId(): string;
export declare function activeReleaseNodeModulesPath(): string | null;
