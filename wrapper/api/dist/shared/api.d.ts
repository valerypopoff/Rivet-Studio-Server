export declare function apiReadText(path: string): Promise<string>;
export declare function apiWriteText(path: string, contents: string): Promise<void>;
export declare function apiReadBinary(path: string): Promise<Uint8Array>;
export declare function apiExists(path: string): Promise<boolean>;
