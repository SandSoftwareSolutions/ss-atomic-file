export interface WriteOptions {
  /** Permissions of the new file. Default: those of the file it replaces, or 0o644. */
  mode?: number;
  /** Flush to disk before and after the rename. Default true. */
  fsync?: boolean;
}

export function writeFileAtomic(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void>;
export function writeFileAtomicSync(path: string, data: string | Uint8Array, options?: WriteOptions): void;
export function writeJsonAtomic(path: string, value: unknown, options?: WriteOptions & { space?: number }): Promise<void>;
export function readJson<T = unknown>(path: string, options?: { fallback?: T }): Promise<T>;
export function readJsonSync<T = unknown>(path: string, options?: { fallback?: T }): T;
