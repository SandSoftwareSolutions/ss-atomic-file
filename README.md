# @sandsoftwaresolutions/atomic-file

[![CI](https://github.com/SandSoftwareSolutions/ss-atomic-file/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-atomic-file/actions/workflows/ci.yml)

Write files so that nobody ever sees half of one, even if the power goes out in the middle. For settings, state files and anything on a Raspberry Pi that gets switched off by the plug. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/atomic-file
```

## Usage

```js
import { writeFileAtomic, writeJsonAtomic, readJson } from "@sandsoftwaresolutions/atomic-file";

await writeFileAtomic("/var/lib/app/state.json", text);

await writeJsonAtomic("state.json", { lastRun: Date.now() });
const state = await readJson("state.json", { fallback: { lastRun: 0 } });
```

## Why not just `fs.writeFile`?

`writeFile` first empties the file, then fills it. If the process stops in between (crash, kill, power loss), you are left with an empty or half-written file. This package writes the data to a temporary file in the same folder, flushes it to disk, and renames it over the old one in a single step. After that the folder entry is flushed too. At any moment the file is either the complete old content or the complete new content.

## Details

- `writeFileAtomic(path, data)` takes a string or bytes. `writeFileAtomicSync` is the synchronous twin.
- The permissions of the file you replace are kept exactly (the umask does not reduce them), or pass `{ mode }`. A new file without `mode` gets 0o644 minus the umask. The owner of the file is not carried over.
- A symbolic link is written through: the link stays and the file it points to is replaced.
- On failure the old file is untouched and the temporary file is removed.
- `fsync: false` skips the flushing when speed matters more than surviving a power cut.
- `readJson` ignores a byte order mark. `readJson` with `fallback` only covers a **missing** file. A file that exists but is not valid JSON always throws, with its path in the message, so a damaged state file is never silently replaced by defaults.
- On Windows the rename is retried for about a second when a virus scanner or a busy reader holds the file (a reader that opens the file in a tight loop made the 0.3 s of the first version run out with EPERM).
- The temporary file lives in the same folder (it has to be on the same disk for the rename to be atomic), so that folder must be writable.

It makes a single file write safe. It does not make a read-modify-write cycle safe against another process doing the same: combine it with `@sandsoftwaresolutions/file-lock` for that.
