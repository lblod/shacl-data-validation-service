import * as fs from "node:fs/promises";
import path from "path";

// NOTE (04/11/2026): The ~extensions~ argument is an array to more easily allow
// extending it to more file types in the future.  In that case the rdf-ext
// helper function ~insertContentInDataset~ should also be made configurable to
// handle different formats.
export async function listFiles(dir, extensions = [".ttl"]) {
  try {
    const entries = await fs.readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });

    if (!dir.endsWith("/")) {
      dir += "/";
    }

    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          extensions.includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch (err) {
    console.error(
      `\n>> ERROR: failed to read files from ${dir}\n>> Full error: "${err}"`,
    );
    return [];
  }
}

export async function readFile(filename) {
  try {
    const fileContents = await fs.readFile(filename);
    return fileContents;
  } catch (err) {
    console.error(
      `\n>> ERROR: failed to read file ${filename}\n>> Full error: "${err}"`,
    );
  }
}
