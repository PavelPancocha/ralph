import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimePaths, RunState, SpecDocument } from "./types.js";

const execFileAsync = promisify(execFile);

function utcStamp(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "");
}

export function defaultWorkspaceRoot(projectRoot: string): string {
  return path.resolve(projectRoot, "..");
}

export function buildRuntimePaths(projectRoot: string, workspaceRoot: string): RuntimePaths {
  const root = path.join(projectRoot, ".ralph");
  return {
    projectRoot,
    workspaceRoot,
    ralphRoot: root,
    runsRoot: path.join(root, "runs"),
    sessionsRoot: path.join(root, "sessions"),
    stateRoot: path.join(root, "state"),
    reportsRoot: path.join(root, "reports"),
    worktreesRoot: path.join(root, "worktrees"),
    artifactsRoot: path.join(root, "artifacts"),
  };
}

export async function ensureRuntimePaths(paths: RuntimePaths): Promise<void> {
  await Promise.all(
    [
      paths.ralphRoot,
      paths.runsRoot,
      paths.sessionsRoot,
      paths.stateRoot,
      paths.reportsRoot,
      paths.worktreesRoot,
      paths.artifactsRoot,
    ].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

export async function loadRunState(paths: RuntimePaths, specId: string): Promise<RunState | null> {
  const statePath = path.join(paths.stateRoot, `${specId}.json`);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function saveRunState(paths: RuntimePaths, state: RunState): Promise<void> {
  const statePath = path.join(paths.stateRoot, `${state.specId}.json`);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function saveArtifact(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = path.join(paths.artifactsRoot, specId, runId);
  await fs.mkdir(dir, { recursive: true });
  const absolute = path.join(dir, `${name}.json`);
  await fs.writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolute;
}

export async function saveDoneReport(
  paths: RuntimePaths,
  spec: SpecDocument,
  summary: string,
  candidateCommit: string,
): Promise<string> {
  const doneDir = path.join(paths.reportsRoot, "done");
  await fs.mkdir(doneDir, { recursive: true });
  const reportPath = path.join(doneDir, `${spec.specId}.md`);
  const content = [
    `# Done: ${spec.specId}`,
    "",
    `Spec: ${spec.relFromSpecs}`,
    `Commit: ${candidateCommit}`,
    "",
    summary,
    "",
  ].join("\n");
  await fs.writeFile(reportPath, content, "utf8");
  return reportPath;
}

export async function legacyDoneExists(projectRoot: string, spec: SpecDocument): Promise<boolean> {
  const donePath = path.join(projectRoot, "specs", "done", spec.relFromSpecs);
  try {
    await fs.access(donePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepoPath(paths: RuntimePaths, spec: SpecDocument): Promise<string> {
  const repoPath = path.resolve(paths.workspaceRoot, spec.workdir);
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Repo path does not exist for spec ${spec.specId}: ${repoPath}`);
  }
  return repoPath;
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(src, dest);
      continue;
    }
    await fs.copyFile(src, dest);
  }
}

export async function installWorktreeCodexSupport(paths: RuntimePaths, worktreePath: string): Promise<void> {
  const source = path.join(paths.projectRoot, "codex-support");
  const dest = path.join(worktreePath, ".codex");
  await copyDirectory(source, dest);
}

export async function ensureSpecWorktree(
  paths: RuntimePaths,
  spec: SpecDocument,
  repoPath: string,
): Promise<string> {
  const worktreePath = path.join(paths.worktreesRoot, spec.specId);
  if (await pathExists(worktreePath)) {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (stdout.trim() === spec.branchInstructions.createBranch) {
      await installWorktreeCodexSupport(paths, worktreePath);
      return worktreePath;
    }
    await execFileAsync("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
  }

  await fs.mkdir(paths.worktreesRoot, { recursive: true });
  const branchExists = await localBranchExists(repoPath, spec.branchInstructions.createBranch);
  if (branchExists) {
    await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "add",
      worktreePath,
      spec.branchInstructions.createBranch,
    ]);
  } else {
    await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "add",
      "-b",
      spec.branchInstructions.createBranch,
      worktreePath,
      spec.branchInstructions.sourceBranch,
    ]);
  }
  await installWorktreeCodexSupport(paths, worktreePath);
  return worktreePath;
}

export function createRunId(): string {
  return utcStamp();
}

export async function readJsonFile<T>(absolute: string): Promise<T> {
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(absolute: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function relativeFromProject(projectRoot: string, absolute: string): string {
  return path.relative(projectRoot, absolute).replaceAll(path.sep, "/");
}

export function defaultCodexHome(paths: RuntimePaths): string {
  return path.join(paths.ralphRoot, "codex-home");
}

export async function ensureCodexHome(paths: RuntimePaths): Promise<string> {
  const codexHome = defaultCodexHome(paths);
  await fs.mkdir(codexHome, { recursive: true });
  return codexHome;
}

export async function listRunStates(paths: RuntimePaths): Promise<RunState[]> {
  const entries = await fs.readdir(paths.stateRoot, { withFileTypes: true }).catch(() => []);
  const states: RunState[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const state = await readJsonFile<RunState>(path.join(paths.stateRoot, entry.name));
    states.push(state);
  }
  states.sort((a, b) => a.specId.localeCompare(b.specId));
  return states;
}

export function initialRunState(spec: SpecDocument, legacyDoneDetected: boolean): RunState {
  return {
    specId: spec.specId,
    specRel: spec.relFromSpecs,
    status: legacyDoneDetected ? "done" : "queued",
    currentIteration: 0,
    runId: undefined,
    worktreePath: undefined,
    lastCommit: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
    threads: {
      supervisor: undefined,
      understander: undefined,
      implementer: undefined,
      reviewerCorrectness: undefined,
      reviewerTests: undefined,
      reviewerSecurity: undefined,
      reviewerPerformance: undefined,
      recheck: undefined,
    },
    legacyDoneDetected,
  };
}

export function runtimeSummary(paths: RuntimePaths): string {
  return [
    `projectRoot=${paths.projectRoot}`,
    `workspaceRoot=${paths.workspaceRoot}`,
    `runtimeRoot=${paths.ralphRoot}`,
    `worktreesRoot=${paths.worktreesRoot}`,
  ].join("\n");
}

export function platformNode(): string {
  return os.platform();
}
