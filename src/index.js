import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";

const tempPath = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
const toBuffer = (data) => (typeof data === "string" ? Buffer.from(data, "utf8") : data instanceof Uint8Array ? data : null);

function checkData(data) {
  const buffer = toBuffer(data);
  if (!buffer) throw new TypeError("atomic-file: data must be a string or a Uint8Array");
  return buffer;
}

async function currentMode(path, mode) {
  if (mode !== undefined) return mode;
  try {
    return (await stat(path)).mode & 0o7777;
  } catch {
    return 0o644;
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
  const temp = tempPath(path);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, await currentMode(path, mode));
  try {
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
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/** The synchronous version of `writeFileAtomic`. */
export function writeFileAtomicSync(path, data, { mode, fsync = true } = {}) {
  const buffer = checkData(data);
  const temp = tempPath(path);
  let useMode = mode;
  if (useMode === undefined) {
    try {
      useMode = statSync(path).mode & 0o7777;
    } catch {
      useMode = 0o644;
    }
  }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, useMode);
  try {
    writeSync(fd, buffer);
    if (fsync) fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
}

/** Writes JSON atomically, with a final newline. `space` defaults to 2. */
export function writeJsonAtomic(path, value, { space = 2, ...options } = {}) {
  const text = JSON.stringify(value, null, space);
  if (text === undefined) throw new TypeError("atomic-file: the value cannot be written as JSON");
  return writeFileAtomic(path, `${text}\n`, options);
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
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`atomic-file: ${path} is not valid JSON: ${error.message}`);
  }
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
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`atomic-file: ${path} is not valid JSON: ${error.message}`);
  }
}
