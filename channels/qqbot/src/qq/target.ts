import type { QQScope, QQTarget } from "./client.js";

export function parseTarget(input: string | QQTarget): QQTarget {
  if (typeof input !== "string") return validateTarget(input);
  const separator = input.indexOf(":");
  if (separator <= 0) throw new Error(`Invalid QQ target: ${input}`);
  const scope = input.slice(0, separator);
  const targetId = input.slice(separator + 1);
  return validateTarget({ scope: scope as QQScope, targetId });
}

export function validateTarget(target: QQTarget): QQTarget {
  if (target.scope !== "c2c" && target.scope !== "group") {
    throw new Error(`Unsupported QQ target scope: ${String(target.scope)}`);
  }
  if (!target.targetId || target.targetId.trim() !== target.targetId) {
    throw new Error("QQ targetId must be a non-empty, trimmed string");
  }
  return { ...target };
}
