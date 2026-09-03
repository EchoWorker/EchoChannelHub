import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolveAllowedLocalFile(input: string, allowedRoots: string[], maxBytes = 20 * 1024 * 1024): Promise<string> {
  if (!isAbsolute(input)) throw new Error("Local media path must be absolute");
  if (!allowedRoots.length) throw new Error("No local media roots are allowed");
  const candidate = await realpath(resolve(input));
  const roots = await Promise.all(allowedRoots.map((root) => realpath(resolve(root))));
  if (!roots.some((root) => inside(candidate, root))) throw new Error("Local media path escapes allowed roots");
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("Local media path is not a regular file");
  if (info.size > maxBytes) throw new Error("Local media exceeds size limit");
  return candidate;
}
