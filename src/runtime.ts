import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentThreadPolicies,
  AgentThreadRefs,
  ImplementationReport,
  ReviewFinding,
  RuntimePaths,
  RunState,
  SpecDocument,
  WorkflowProgressEvent,
} from "./types.js";

const execFileAsync = promisify(execFile);
const runStateVersion = 2;

function emptyThreadRefs(): AgentThreadRefs {
  return {
    planningSpec: undefined,
    planningRepo: undefined,
    planningRisks: undefined,
    supervisor: undefined,
    understander: undefined,
    implementer: undefined,
    reviewerCorrectness: undefined,
    reviewerTests: undefined,
    reviewerSecurity: undefined,
    reviewerPerformance: undefined,
    reviewLead: undefined,
    recheck: undefined,
  };
}

function emptyThreadPolicies(): AgentThreadPolicies {
  return {
    planningSpec: undefined,
    planningRepo: undefined,
    planningRisks: undefined,
    supervisor: undefined,
    understander: undefined,
    implementer: undefined,
    reviewerCorrectness: undefined,
    reviewerTests: undefined,
    reviewerSecurity: undefined,
    reviewerPerformance: undefined,
    reviewLead: undefined,
    recheck: undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeThreads(raw: unknown): AgentThreadRefs {
  const value = isRecord(raw) ? raw : {};
  return {
    planningSpec: stringOrUndefined(value.planningSpec),
    planningRepo: stringOrUndefined(value.planningRepo),
    planningRisks: stringOrUndefined(value.planningRisks),
    supervisor: stringOrUndefined(value.supervisor),
    understander: stringOrUndefined(value.understander),
    implementer: stringOrUndefined(value.implementer),
    reviewerCorrectness: stringOrUndefined(value.reviewerCorrectness),
    reviewerTests: stringOrUndefined(value.reviewerTests),
    reviewerSecurity: stringOrUndefined(value.reviewerSecurity),
    reviewerPerformance: stringOrUndefined(value.reviewerPerformance),
    reviewLead: stringOrUndefined(value.reviewLead),
    recheck: stringOrUndefined(value.recheck),
  };
}

function normalizeThreadPolicies(raw: unknown): AgentThreadPolicies {
  const value = isRecord(raw) ? raw : {};
  return {
    planningSpec: stringOrUndefined(value.planningSpec),
    planningRepo: stringOrUndefined(value.planningRepo),
    planningRisks: stringOrUndefined(value.planningRisks),
    supervisor: stringOrUndefined(value.supervisor),
    understander: stringOrUndefined(value.understander),
    implementer: stringOrUndefined(value.implementer),
    reviewerCorrectness: stringOrUndefined(value.reviewerCorrectness),
    reviewerTests: stringOrUndefined(value.reviewerTests),
    reviewerSecurity: stringOrUndefined(value.reviewerSecurity),
    reviewerPerformance: stringOrUndefined(value.reviewerPerformance),
    reviewLead: stringOrUndefined(value.reviewLead),
    recheck: stringOrUndefined(value.recheck),
  };
}

function normalizeStatus(value: unknown): RunState["status"] {
  switch (value) {
    case "queued":
    case "planning":
    case "implementing":
    case "reviewing":
    case "rechecking":
    case "done":
    case "failed":
      return value;
    default:
      return "queued";
  }
}

function normalizeIteration(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeRunState(raw: unknown, specIdFallback: string): RunState | null {
  if (!isRecord(raw)) {
    return null;
  }

  return {
    stateVersion: runStateVersion,
    specId: stringOrUndefined(raw.specId) ?? specIdFallback,
    specRel: stringOrUndefined(raw.specRel) ?? "",
    status: normalizeStatus(raw.status),
    currentIteration: normalizeIteration(raw.currentIteration),
    runId: stringOrUndefined(raw.runId),
    worktreePath: stringOrUndefined(raw.worktreePath),
    lastCommit: stringOrUndefined(raw.lastCommit),
    lastError: stringOrUndefined(raw.lastError),
    updatedAt: stringOrUndefined(raw.updatedAt) ?? new Date().toISOString(),
    threads: normalizeThreads(raw.threads),
    threadPolicies: normalizeThreadPolicies(raw.threadPolicies),
    legacyDoneDetected: raw.legacyDoneDetected === true,
    invalidationReason: stringOrUndefined(raw.invalidationReason),
  };
}

async function readNormalizedRunState(statePath: string, specId: string): Promise<{ raw: string; normalized: RunState } | null> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const normalized = normalizeRunState(JSON.parse(raw) as unknown, specId);
    if (!normalized) {
      return null;
    }
    return { raw, normalized };
  } catch {
    return null;
  }
}

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
  const loaded = await readNormalizedRunState(statePath, specId);
  if (!loaded) {
    return null;
  }
  const serialized = `${JSON.stringify(loaded.normalized, null, 2)}\n`;
  if (loaded.raw !== serialized) {
    await fs.writeFile(statePath, serialized, "utf8");
  }
  return loaded.normalized;
}

export async function peekRunState(paths: RuntimePaths, specId: string): Promise<RunState | null> {
  const statePath = path.join(paths.stateRoot, `${specId}.json`);
  const loaded = await readNormalizedRunState(statePath, specId);
  return loaded?.normalized ?? null;
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
  let absolute = path.join(dir, `${name}.json`);
  let suffix = 2;
  while (await pathExists(absolute)) {
    absolute = path.join(dir, `${name}-${suffix}.json`);
    suffix += 1;
  }
  await fs.writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absolute;
}

export function runLogDirectory(paths: RuntimePaths, specId: string, runId: string): string {
  return path.join(paths.runsRoot, specId, runId);
}

export function runEventLogPath(paths: RuntimePaths, specId: string, runId: string): string {
  return path.join(runLogDirectory(paths, specId, runId), "events.log");
}

export function formatWorkflowProgressEvent(event: WorkflowProgressEvent): string {
  const metadata = [`phase=${event.phase}`];
  if (event.iteration !== undefined) {
    metadata.push(`iteration=${event.iteration}`);
  }
  if (event.reviewer) {
    metadata.push(`reviewer=${event.reviewer}`);
  }
  if (event.candidateCommit) {
    metadata.push(`commit=${event.candidateCommit}`);
  }
  return `${event.timestamp} ${metadata.join(" ")} ${event.summary}`;
}

export async function appendRunEvent(paths: RuntimePaths, event: WorkflowProgressEvent): Promise<string> {
  const absolute = runEventLogPath(paths, event.specId, event.runId);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.appendFile(absolute, `${formatWorkflowProgressEvent(event)}\n`, "utf8");
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

export async function gitRefExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  return gitRefExists(repoPath, `refs/heads/${branch}`);
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

async function readGitStdout(worktreePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, ...args]);
  return stdout.trim();
}

async function readGitLines(worktreePath: string, args: string[]): Promise<string[]> {
  const output = await readGitStdout(worktreePath, args);
  return output === "" ? [] : output.split(/\r?\n/);
}

async function ignoreWorktreePath(worktreePath: string, pattern: string): Promise<void> {
  const excludePath = path.resolve(worktreePath, await readGitStdout(worktreePath, ["rev-parse", "--git-path", "info/exclude"]));
  const current = await fs.readFile(excludePath, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/).filter((line) => line !== "");
  if (lines.includes(pattern)) {
    return;
  }
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await fs.writeFile(excludePath, `${prefix}${pattern}\n`, "utf8");
}

export async function installWorktreeCodexSupport(paths: RuntimePaths, worktreePath: string): Promise<void> {
  const source = path.join(paths.projectRoot, "codex-support");
  const dest = path.join(worktreePath, ".codex");
  await copyDirectory(source, dest);
  await ignoreWorktreePath(worktreePath, ".codex/");
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

function sourceCodexHome(): string {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

export async function ensureCodexHome(paths: RuntimePaths): Promise<string> {
  const codexHome = defaultCodexHome(paths);
  await fs.mkdir(codexHome, { recursive: true });
  const externalCodexHome = sourceCodexHome();
  if (path.resolve(externalCodexHome) !== path.resolve(codexHome)) {
    for (const fileName of ["auth.json", "config.toml"]) {
      const source = path.join(externalCodexHome, fileName);
      const destination = path.join(codexHome, fileName);
      if ((await pathExists(source)) && !(await pathExists(destination))) {
        await fs.copyFile(source, destination);
      }
    }
  }
  return codexHome;
}

export async function worktreeAdditionalDirectories(worktreePath: string): Promise<string[]> {
  const gitDir = path.resolve(worktreePath, await readGitStdout(worktreePath, ["rev-parse", "--git-dir"]));
  const commonDir = path.resolve(worktreePath, await readGitStdout(worktreePath, ["rev-parse", "--git-common-dir"]));
  return [...new Set([gitDir, commonDir])];
}

export async function validateImplementationCandidate(
  worktreePath: string,
  report: ImplementationReport,
): Promise<ReviewFinding | null> {
  const problems: string[] = [];
  let commitExists = false;
  try {
    await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--verify", `${report.commitHash}^{commit}`]);
    commitExists = true;
  } catch {
    problems.push(`Reported commit ${report.commitHash} does not exist as a local commit.`);
  }

  const headCommit = await readGitStdout(worktreePath, ["rev-parse", "HEAD"]);
  if (headCommit !== report.commitHash) {
    problems.push(`HEAD is ${headCommit}, not the reported commit ${report.commitHash}.`);
  }

  if (commitExists) {
    const committedFiles = [...new Set(await readGitLines(worktreePath, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", report.commitHash]))].sort();
    const reportedFiles = [...new Set(report.changedFiles)].sort();
    if (committedFiles.join("\n") !== reportedFiles.join("\n")) {
      problems.push(
        `Reported changed files ${reportedFiles.join(", ") || "(none)"} do not match committed files ${committedFiles.join(", ") || "(none)"}.`,
      );
    }
  }

  const dirtyEntries = await readGitLines(worktreePath, ["status", "--short"]);
  if (dirtyEntries.length > 0) {
    problems.push(`Worktree is not clean after the reported commit: ${dirtyEntries.join(" | ")}.`);
  }

  if (problems.length === 0) {
    return null;
  }

  return {
    severity: "error",
    category: "correctness",
    title: "Reported candidate commit does not match repository state",
    detail: problems.join(" "),
    action: "Create and check out a real commit for the implemented changes, leave the worktree clean, and then report that exact commit hash.",
  };
}

export async function listRunStates(paths: RuntimePaths): Promise<RunState[]> {
  const entries = await fs.readdir(paths.stateRoot, { withFileTypes: true }).catch(() => []);
  const states: RunState[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const specId = path.basename(entry.name, ".json");
    const loaded = await readNormalizedRunState(path.join(paths.stateRoot, entry.name), specId);
    if (loaded) {
      states.push(loaded.normalized);
    }
  }
  states.sort((a, b) => a.specId.localeCompare(b.specId));
  return states;
}

export function initialRunState(spec: SpecDocument, legacyDoneDetected: boolean): RunState {
  return {
    stateVersion: runStateVersion,
    specId: spec.specId,
    specRel: spec.relFromSpecs,
    status: legacyDoneDetected ? "done" : "queued",
    currentIteration: 0,
    runId: undefined,
    worktreePath: undefined,
    lastCommit: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
    threads: emptyThreadRefs(),
    threadPolicies: emptyThreadPolicies(),
    legacyDoneDetected,
    invalidationReason: undefined,
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
