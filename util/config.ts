import * as fs from "node:fs/promises";

export async function listFiles(dir) {
  try {
    const filenames = await fs.readdir(dir);

    if (!dir.endsWith("/")) {
      dir += "/";
    }

    return filenames.map((file) => dir + file);
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
