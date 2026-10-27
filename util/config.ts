import { readdir } from "node:fs/promises";

export async function listFiles(dir) {
  try {
    const filenames = await readdir(dir);

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
