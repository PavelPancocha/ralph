import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";

import { defaultSpecRoot } from "./spec-roots.js";
import type { BranchInstructions, SpecDocument } from "./types.js";

const SPEC_FILE_RE = /^\d{4,}-.*\.md$/;
const legacySpecDirs = new Set(["done", "plans", "sessions", "candidates"]);
const execFile = promisify(execFileCb);

interface SpecReadOptions {
  onWarning?: (message: string) => void;
}

type SpecSource =
  | {
      kind: "filesystem";
      specsRoot: string;
      warning?: string;
    }
  | {
      kind: "git-fallback";
      specsRoot: string;
      repoRoot: string;
      repoRelativeSpecsRoot: string;
      ref: string;
      warning: string;
    };

const specSourceCache = new Map<string, Promise<SpecSource>>();

const branchInstructionsSchema = z.object({
  sourceBranch: z.string().min(1),
  createBranch: z.string().min(1),
  prTarget: z.string().optional(),
  nextSpecBase: z.string().optional(),
  createPr: z.boolean().optional(),
  draftPr: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});

function normalizeLine(line: string): string {
  return line.replace(/\r$/, "");
}

function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "__preamble__";
  const lines = content.split("\n").map(normalizeLine);

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const heading = headingMatch[1];
      if (!heading) {
        continue;
      }
      current = heading.trim();
      sections[current] = "";
      continue;
    }
    const existing = sections[current] ?? "";
    sections[current] = `${existing}${line}\n`;
  }

  return Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, value.trim()]),
  );
}

function parseBulletList(block: string | undefined): string[] {
  if (!block) {
    return [];
  }

  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseParagraph(block: string | undefined, fallback = ""): string {
  if (!block) {
    return fallback;
  }

  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function parseCodeFenceCommands(block: string | undefined): string[] {
  if (!block) {
    return [];
  }

  const commands: string[] = [];
  const fencePattern = /```(?:bash)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;
  while ((match = fencePattern.exec(block)) !== null) {
    const snippet = match[1]!
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    commands.push(...snippet);
  }

  return commands;
}

function parseInstructionValue(line: string, label: string): string | undefined {
  const match = new RegExp(`^${label}:\\s*(.+)$`).exec(line);
  if (!match) {
    return undefined;
  }
  const rawValue = match[1]!.trim();
  if (rawValue.startsWith("`") && rawValue.endsWith("`")) {
    return rawValue.slice(1, -1).trim();
  }
  return rawValue;
}

function parseQuotedBacktickValues(line: string): string[] {
  const matches = [...line.matchAll(/`([^`]+)`/g)];
  return matches.map((match) => match[1]!.trim()).filter(Boolean);
}

function parseBranchInstructions(block: string | undefined): BranchInstructions {
  const lines = parseBulletList(block);
  const parsed: Partial<BranchInstructions> = {};

  for (const line of lines) {
    const source = parseInstructionValue(line, "Source branch");
    if (source !== undefined) {
      parsed.sourceBranch = source;
      continue;
    }
    const create = parseInstructionValue(line, "Create branch");
    if (create !== undefined) {
      parsed.createBranch = create;
      continue;
    }
    const prTarget = parseInstructionValue(line, "PR target");
    if (prTarget !== undefined) {
      parsed.prTarget = prTarget;
      continue;
    }
    const nextBase = parseInstructionValue(line, "Next spec base");
    if (nextBase !== undefined) {
      parsed.nextSpecBase = nextBase;
      continue;
    }
    if (/^Open a \*\*draft\*\* PR for this spec branch\.?$/i.test(line)) {
      parsed.createPr = true;
      parsed.draftPr = true;
      continue;
    }
    if (/^Open a PR for this spec branch\.?$/i.test(line)) {
      parsed.createPr = true;
      parsed.draftPr = false;
      continue;
    }
    if (line.startsWith("Apply labels:")) {
      parsed.labels = parseQuotedBacktickValues(line);
    }
  }

  const validated = branchInstructionsSchema.parse(parsed);
  return {
    sourceBranch: validated.sourceBranch,
    createBranch: validated.createBranch,
    ...(validated.prTarget ? { prTarget: validated.prTarget } : {}),
    ...(validated.nextSpecBase ? { nextSpecBase: validated.nextSpecBase } : {}),
    ...(validated.createPr !== undefined ? { createPr: validated.createPr } : {}),
    ...(validated.draftPr !== undefined ? { draftPr: validated.draftPr } : {}),
    ...(validated.labels?.length ? { labels: validated.labels } : {}),
  };
}

function isRunnableSpecContent(raw: string): boolean {
  const lines = raw.split("\n").map(normalizeLine);
  const repoLine = lines.find((line) => line.startsWith("Repo:"));
  const workdirLine = lines.find((line) => line.startsWith("Workdir:"));
  if (!repoLine || !workdirLine) {
    return false;
  }
  if (!repoLine.replace("Repo:", "").trim() || !workdirLine.replace("Workdir:", "").trim()) {
    return false;
  }
  try {
    parseBranchInstructions(parseSections(raw)["Branch Instructions"]);
    return true;
  } catch {
    return false;
  }
}

async function isRunnableSpecFile(absolute: string): Promise<boolean> {
  return isRunnableSpecContent(await fs.readFile(absolute, "utf8"));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findExistingAncestor(targetPath: string): Promise<string | null> {
  let current = path.resolve(targetPath);
  while (true) {
    if (await pathExists(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readGitStdout(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

function displayGitRef(ref: string): string {
  return ref.startsWith("refs/remotes/") ? ref.replace(/^refs\/remotes\//, "") : ref;
}

function pathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function applySpecSourceWarning(source: SpecSource, options?: SpecReadOptions): void {
  if (source.warning) {
    options?.onWarning?.(source.warning);
  }
}

async function listGitSpecFiles(source: Extract<SpecSource, { kind: "git-fallback" }>): Promise<string[]> {
  const { stdout } = await execFile("git", [
    "-C",
    source.repoRoot,
    "ls-tree",
    "-r",
    "--name-only",
    source.ref,
    "--",
    source.repoRelativeSpecsRoot,
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((repoRelativePath) => path.posix.relative(source.repoRelativeSpecsRoot, repoRelativePath))
    .filter((relFromSpecs) => relFromSpecs && relFromSpecs !== ".");
}

async function readGitSpecContent(
  source: Extract<SpecSource, { kind: "git-fallback" }>,
  relFromSpecs: string,
): Promise<string> {
  const repoRelativePath = path.posix.join(
    source.repoRelativeSpecsRoot.replaceAll(path.sep, "/"),
    relFromSpecs.replaceAll(path.sep, "/"),
  );
  const { stdout } = await execFile("git", [
    "-C",
    source.repoRoot,
    "show",
    `${source.ref}:${repoRelativePath}`,
  ]);
  return stdout;
}

async function resolveSpecSource(specsRoot: string): Promise<SpecSource> {
  const resolvedSpecsRoot = path.resolve(specsRoot);
  const cached = specSourceCache.get(resolvedSpecsRoot);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<SpecSource> => {
    try {
      const stat = await fs.stat(resolvedSpecsRoot);
      if (stat.isDirectory()) {
        return {
          kind: "filesystem",
          specsRoot: resolvedSpecsRoot,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const ancestor = await findExistingAncestor(path.dirname(resolvedSpecsRoot));
    if (!ancestor) {
      throw new Error(`Spec root does not exist: ${resolvedSpecsRoot}`);
    }

    let repoRoot: string;
    try {
      repoRoot = await readGitStdout(ancestor, ["rev-parse", "--show-toplevel"]);
    } catch {
      throw new Error(`Spec root does not exist: ${resolvedSpecsRoot}`);
    }

    if (!pathInsideRoot(repoRoot, resolvedSpecsRoot)) {
      throw new Error(`Spec root does not exist: ${resolvedSpecsRoot}`);
    }

    let fallbackRef: string;
    try {
      fallbackRef = await readGitStdout(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    } catch {
      throw new Error(
        `Spec root ${resolvedSpecsRoot} is missing on the current checkout, and origin/HEAD is not available for fallback.`,
      );
    }

    const repoRelativeSpecsRoot = path.relative(repoRoot, resolvedSpecsRoot).replaceAll(path.sep, "/");
    const files = await listGitSpecFiles({
      kind: "git-fallback",
      specsRoot: resolvedSpecsRoot,
      repoRoot,
      repoRelativeSpecsRoot,
      ref: fallbackRef,
      warning: "",
    });
    if (files.length === 0) {
      throw new Error(
        `Spec root ${resolvedSpecsRoot} is missing on the current checkout and is also absent in ${displayGitRef(fallbackRef)}.`,
      );
    }

    return {
      kind: "git-fallback",
      specsRoot: resolvedSpecsRoot,
      repoRoot,
      repoRelativeSpecsRoot,
      ref: fallbackRef,
      warning: `Spec root ${resolvedSpecsRoot} is missing on the current checkout; reading specs from ${displayGitRef(fallbackRef)} instead.`,
    };
  })();

  specSourceCache.set(resolvedSpecsRoot, pending);
  try {
    return await pending;
  } catch (error) {
    specSourceCache.delete(resolvedSpecsRoot);
    throw error;
  }
}

function titleFromSpecFilename(filename: string): string {
  const stem = path.basename(filename, ".md");
  const match = /^(\d{4,})-(.+)$/.exec(stem);
  if (!match) {
    throw new Error(`Spec filename must match ${SPEC_FILE_RE}`);
  }
  const number = match[1]!;
  const slug = match[2]!;
  const humanTitle = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return `${number} - ${humanTitle}`;
}

export function buildSampleSpecTemplate(relFromSpecs: string): string {
  const filename = path.basename(relFromSpecs);
  if (!SPEC_FILE_RE.test(filename)) {
    throw new Error(`Spec path must end with a filename like 1234-my-spec.md: ${relFromSpecs}`);
  }

  const title = titleFromSpecFilename(filename);
  return [
    `# ${title}`,
    "",
    "Repo:",
    "Workdir:",
    "",
    "<!-- Required sections: Branch Instructions, Goal, Constraints, Dependencies, Required Reading, Acceptance Criteria, Verification (Fast-First) -->",
    "<!-- Recommended sections: Big Picture, Scope (In), Boundaries (Out, No Overlap), Commit Requirements -->",
    "",
    "## Branch Instructions",
    "- Source branch: ``",
    "- Create branch: ``",
    "- PR target: ``",
    "",
    "## Big Picture",
    "",
    "## Goal",
    "",
    "## Scope (In)",
    "- ",
    "",
    "## Boundaries (Out, No Overlap)",
    "- ",
    "",
    "## Constraints",
    "- ",
    "",
    "## Dependencies",
    "- None.",
    "",
    "## Required Reading",
    "- ",
    "",
    "## Acceptance Criteria",
    "- ",
    "",
    "## Commit Requirements",
    "- Use the requested branch.",
    "",
    "## Verification (Fast-First)",
    "```bash",
    "",
    "```",
    "",
  ].join("\n");
}

export async function createSampleSpecFile(
  projectRoot: string,
  relFromSpecs: string,
  specsRoot = defaultSpecRoot(projectRoot),
): Promise<string> {
  const absolute = path.join(specsRoot, relFromSpecs);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.access(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.writeFile(absolute, buildSampleSpecTemplate(relFromSpecs), "utf8");
      return absolute;
    }
    throw error;
  }
  throw new Error(`Spec already exists: ${relFromSpecs}`);
}

export async function discoverSpecPaths(specsRoot: string, options?: SpecReadOptions): Promise<string[]> {
  const source = await resolveSpecSource(specsRoot);
  applySpecSourceWarning(source, options);
  const result: string[] = [];

  if (source.kind === "git-fallback") {
    const files = await listGitSpecFiles(source);
    for (const relFromSpecs of files) {
      const segments = relFromSpecs.split("/");
      if (segments.some((segment) => legacySpecDirs.has(segment))) {
        continue;
      }
      const fileName = path.posix.basename(relFromSpecs);
      if (!SPEC_FILE_RE.test(fileName)) {
        continue;
      }
      if (!isRunnableSpecContent(await readGitSpecContent(source, relFromSpecs))) {
        continue;
      }
      result.push(relFromSpecs);
    }
    result.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relFromSpecs = path.relative(source.specsRoot, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (legacySpecDirs.has(entry.name)) {
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!SPEC_FILE_RE.test(entry.name)) {
        continue;
      }
      if (!(await isRunnableSpecFile(absolute))) {
        continue;
      }
      result.push(relFromSpecs);
    }
  }

  await walk(source.specsRoot);
  return result;
}

export async function parseSpecFile(
  projectRoot: string,
  workspaceRoot: string,
  relFromSpecs: string,
  specsRoot = defaultSpecRoot(projectRoot),
  options?: SpecReadOptions,
): Promise<SpecDocument> {
  const source = await resolveSpecSource(specsRoot);
  applySpecSourceWarning(source, options);
  const specPath = path.join(source.specsRoot, relFromSpecs);
  const raw = source.kind === "filesystem"
    ? await fs.readFile(specPath, "utf8")
    : await readGitSpecContent(source, relFromSpecs);
  const sections = parseSections(raw);

  const lines = raw.split("\n").map(normalizeLine);
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? relFromSpecs;
  const repoLine = lines.find((line) => line.startsWith("Repo:"));
  const workdirLine = lines.find((line) => line.startsWith("Workdir:"));

  if (!repoLine || !workdirLine) {
    throw new Error(`Spec ${relFromSpecs} must declare Repo: and Workdir:`);
  }

  const repo = repoLine.replace("Repo:", "").trim();
  const workdir = workdirLine.replace("Workdir:", "").trim();
  if (!repo || !workdir) {
    throw new Error(`Spec ${relFromSpecs} must provide non-empty Repo: and Workdir: values`);
  }
  const specId = path.basename(relFromSpecs, ".md");

  const bigPicture = parseParagraph(sections["Big Picture"]);
  return {
    specPath,
    relFromSpecs,
    relFromWorkspace: path.relative(workspaceRoot, specPath).replaceAll(path.sep, "/"),
    specId,
    title,
    repo,
    workdir,
    branchInstructions: parseBranchInstructions(sections["Branch Instructions"]),
    ...(bigPicture ? { bigPicture } : {}),
    goal: parseParagraph(sections["Goal"]),
    scopeIn: parseBulletList(sections["Scope (In)"]),
    boundariesOut: parseBulletList(sections["Boundaries (Out, No Overlap)"] ?? sections["Boundaries (Out)"]),
    constraints: parseBulletList(sections["Constraints"]),
    dependencies: parseBulletList(sections["Dependencies"]),
    requiredReading: parseBulletList(sections["Required Reading"]),
    acceptanceCriteria: parseBulletList(sections["Acceptance Criteria"]),
    commitRequirements: parseBulletList(sections["Commit Requirements"]),
    verificationCommands: parseCodeFenceCommands(sections["Verification (Fast-First)"]),
    rawSections: sections,
  };
}
