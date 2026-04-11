import { createHash } from "node:crypto";
import path from "node:path";

export function defaultSpecRoot(projectRoot: string): string {
  return path.join(projectRoot, "specs");
}

export function resolvePathFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.resolve(projectRoot, targetPath);
}

export function resolveSpecRoot(projectRoot: string, specRoot?: string): string {
  if (!specRoot) {
    return defaultSpecRoot(projectRoot);
  }
  return resolvePathFromProjectRoot(projectRoot, specRoot);
}

export function isDefaultSpecRoot(projectRoot: string, specRoot: string): boolean {
  return path.resolve(specRoot) === path.resolve(defaultSpecRoot(projectRoot));
}

export function specRootRuntimeId(projectRoot: string, specRoot: string): string {
  if (isDefaultSpecRoot(projectRoot, specRoot)) {
    return "default";
  }

  const resolvedSpecRoot = path.resolve(specRoot);
  const relFromProject = path.relative(projectRoot, resolvedSpecRoot).replaceAll(path.sep, "/");
  const labelSource = relFromProject && !relFromProject.startsWith("..")
    ? relFromProject
    : path.basename(resolvedSpecRoot);
  const label = labelSource
    .split("/")
    .filter(Boolean)
    .slice(-3)
    .join("-");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "spec-root";
  const hash = createHash("sha256").update(resolvedSpecRoot).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}
