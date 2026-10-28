import { readdir } from "node:fs/promises";

export async function listFiles(dir) {
  try {
    // Only files: subdirectories, e.g. disabled/, aren't listed
    const entries = await readdir(dir, { withFileTypes: true });

    if (!dir.endsWith("/")) {
      dir += "/";
    }

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => dir + entry.name);
  } catch (err) {
    console.error(`\n>> ERROR: failed to read files from ${dir}`);
    return [];
  }
}

export async function listDirectories(dir) {
  if (!dir.endsWith("/")) {
    dir += "/";
  }

  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => dir + entry.name);
}
