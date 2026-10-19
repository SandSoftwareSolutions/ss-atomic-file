import { closeSync, constants, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";

// The file name is cut short so that a long name plus the suffix still fits in the 255 bytes most file systems allow.
const tempPath = (path) => join(dirname(path), `.${Array.from(basename(path)).slice(0, 48).join("")}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
const toBuffer = (data) => (typeof data === "string" ? Buffer.from(data, "utf8") : data instanceof Uint8Array ? data : null);

function checkData(data) {
  const buffer = toBuffer(data);
  if (!buffer) throw new TypeError("atomic-file: data must be a string or a Uint8Array");
  return buffer;
}

// Returns { mode, exact }: `exact` means the mode must be applied as given (it came from the caller or from the file being
// replaced) and not be reduced by the umask. A new file without a mode gets 0o644 minus the umask, like a normal write.
async function currentMode(path, mode) {
  if (mode !== undefined) return { mode, exact: true };
  try {
    return { mode: (await stat(path)).mode & 0o7777, exact: true };
  } catch {
    return { mode: 0o644, exact: false };
  }
}

// A symbolic link is written through, so the link stays a link and the data lands in the file it points to.
async function resolveTarget(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return; // directories cannot be opened for syncing on Windows
  try {
    const handle = await open(dirname(path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every file system supports it; the rename itself has already happened.
  }
}

/**
 * Writes a file so that nobody ever sees half of it, also if the power goes out or the process is killed: the data goes to a
 * temporary file next to it, is flushed to disk, and then renamed over the old file in one step. Either the old content or the
 * complete new content is there, never something in between. The existing file's permissions are kept (or pass `mode`).
 */
export async function writeFileAtomic(path, data, { mode, fsync = true } = {}) {
  const buffer = checkData(data);
  path = await resolveTarget(path);
  const temp = tempPath(path);
  const wanted = await currentMode(path, mode);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, wanted.mode);
  try {
    if (wanted.exact && process.platform !== "win32") await handle.chmod(wanted.mode);
    await handle.writeFile(buffer);
    if (fsync) await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await renameWithRetry(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  if (fsync) await syncDirectory(path);
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      // Windows can refuse for a moment while a virus scanner or another reader has the target open.
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 15) throw error;
      await new Promise((r) => setTimeout(r, Math.min(10 * (attempt + 1), 100)));
    }
  }
}

/** The synchronous version of `writeFileAtomic`. */
export function writeFileAtomicSync(path, data, { mode, fsync = true } = {}) {
  const buffer = checkData(data);
  try {
    path = realpathSync(path);
  } catch {
    // Does not exist yet (or a dangling link): write to the path as given.
  }
  const temp = tempPath(path);
  let useMode = mode;
  let exact = mode !== undefined;
  if (useMode === undefined) {
    try {
      useMode = statSync(path).mode & 0o7777;
      exact = true;
    } catch {
      useMode = 0o644;
    }
  }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, useMode);
  try {
    if (exact && process.platform !== "win32") fchmodSync(fd, useMode);
    writeSync(fd, buffer);
    if (fsync) fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
  closeSync(fd);
  try {
    renameWithRetrySync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
  if (fsync) syncDirectorySync(path);
}

function renameWithRetrySync(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 15) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * (attempt + 1), 100));
    }
  }
}

function syncDirectorySync(path) {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every file system supports it; the rename itself has already happened.
  }
}

/** Writes JSON atomically, with a final newline. `space` defaults to 2. */
export async function writeJsonAtomic(path, value, { space = 2, ...options } = {}) {
  const text = JSON.stringify(value, null, space);
  if (text === undefined) throw new TypeError("atomic-file: the value cannot be written as JSON");
  await writeFileAtomic(path, `${text}\n`, options);
}

// A byte order mark (added by some Windows editors) is not part of the JSON text.
function parseJson(text, path) {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new SyntaxError(`atomic-file: ${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * Reads a JSON file. When the file does not exist you get `fallback` (if you pass one) instead of an error; a file that exists
 * but is not valid JSON always throws, with the path in the message, so a corrupt file is never mistaken for a missing one.
 */
export async function readJson(path, { fallback } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
  return parseJson(text, path);
}

/** The synchronous version of `readJson`. */
export function readJsonSync(path, { fallback } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
  return parseJson(text, path);
}
