import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentThreadPolicies,
  AgentThreadRefs,
  ImplementationReport,
  PublicationResult,
  ReviewFinding,
  RuntimePaths,
  RunState,
  SpecDocument,
  VerificationRun,
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

export async function readArtifactJson<T>(
  paths: RuntimePaths,
  specId: string,
  runId: string,
  name: string,
): Promise<T | null> {
  const absolute = path.join(paths.artifactsRoot, specId, runId, `${name}.json`);
  try {
    return await readJsonFile<T>(absolute);
  } catch {
    return null;
  }
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
  candidateCommit?: string,
): Promise<string> {
  const doneDir = path.join(paths.reportsRoot, "done");
  await fs.mkdir(doneDir, { recursive: true });
  const reportPath = path.join(doneDir, `${spec.specId}.md`);
  const content = [
    `# Done: ${spec.specId}`,
    "",
    `Spec: ${spec.relFromSpecs}`,
    `Commit: ${candidateCommit ?? "manual"}`,
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

export async function listCandidateChangedFiles(
  worktreePath: string,
  commitHash: string,
  baseRef?: string,
): Promise<string[]> {
  const rawFiles = baseRef
    ? await readGitLines(worktreePath, [
      "diff",
      "--name-only",
      `${await readGitStdout(worktreePath, ["merge-base", commitHash, baseRef])}..${commitHash}`,
    ])
    : await readGitLines(worktreePath, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commitHash]);
  return [...new Set(rawFiles)].sort();
}

async function readGitBranch(worktreePath: string): Promise<string | undefined> {
  const branch = await readGitStdout(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? undefined : branch;
}

async function checkoutGitRef(repoPath: string, ref: string): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, "checkout", "--ignore-other-worktrees", ref]);
}

async function checkoutDetachedCommit(repoPath: string, commit: string): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, "checkout", "--detach", commit]);
}

async function runShellCommand(
  cwd: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
      });
    });
  });
}

async function execTool(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { cwd, env: { ...process.env } });
}

async function githubRepoNameWithOwner(repoPath: string): Promise<string> {
  const { stdout } = await execTool("gh", ["repo", "view", "--json", "nameWithOwner"], repoPath);
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || typeof parsed.nameWithOwner !== "string") {
    throw new Error(`Unable to resolve GitHub repo nameWithOwner for ${repoPath}.`);
  }
  return parsed.nameWithOwner;
}

async function remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
  const { stdout } = await execTool("git", ["-C", repoPath, "ls-remote", "--heads", remote, branch], repoPath);
  return stdout.trim() !== "";
}

async function githubRepoLabels(repoPath: string, repoFullName: string): Promise<string[]> {
  const { stdout } = await execTool("gh", ["api", `repos/${repoFullName}/labels?per_page=200`], repoPath);
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Unable to load GitHub labels for ${repoFullName}.`);
  }
  return parsed
    .map((item) => (isRecord(item) && typeof item.name === "string" ? item.name : undefined))
    .filter((item): item is string => item !== undefined);
}

async function ensureGithubLabel(repoPath: string, repoFullName: string, label: string): Promise<void> {
  try {
    await execTool(
      "gh",
      ["label", "create", label, "--repo", repoFullName, "--color", "D4D4D4", "--description", `Ralph-managed label: ${label}`],
      repoPath,
    );
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    if (/already exists/i.test(stderr)) {
      return;
    }
    throw error;
  }
}

async function resolveGithubLabelNames(repoPath: string, repoFullName: string, labels: string[]): Promise<string[]> {
  const existing = await githubRepoLabels(repoPath, repoFullName);
  const resolved: string[] = [];
  for (const label of labels) {
    const canonical = existing.find((candidate) => candidate.toLowerCase() === label.toLowerCase());
    if (canonical) {
      resolved.push(canonical);
      continue;
    }
    await ensureGithubLabel(repoPath, repoFullName, label);
    resolved.push(label);
  }
  return [...new Set(resolved)];
}

interface GithubPullRequestSummary {
  number: number;
  url: string;
  isDraft: boolean;
}

const pullRequestTemplateCandidates = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

async function listPullRequestsForBranch(
  repoPath: string,
  repoFullName: string,
  branch: string,
): Promise<GithubPullRequestSummary[]> {
  const { stdout } = await execTool(
    "gh",
    ["pr", "list", "--repo", repoFullName, "--head", branch, "--state", "all", "--json", "number,url,isDraft"],
    repoPath,
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected gh pr list response for branch ${branch}.`);
  }
  return parsed
    .filter((item): item is GithubPullRequestSummary => {
      return isRecord(item)
        && typeof item.number === "number"
        && typeof item.url === "string"
        && typeof item.isDraft === "boolean";
    });
}

async function loadPullRequestTemplate(repoPath: string): Promise<string | undefined> {
  for (const relativePath of pullRequestTemplateCandidates) {
    const absolutePath = path.join(repoPath, relativePath);
    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const templateDirectory = path.join(repoPath, ".github", "PULL_REQUEST_TEMPLATE");
  try {
    const entries = await fs.readdir(templateDirectory);
    const markdownTemplates = entries
      .filter((entry) => entry.toLowerCase().endsWith(".md"))
      .sort((left, right) => left.localeCompare(right));
    if (markdownTemplates.length === 0) {
      return undefined;
    }
    return await fs.readFile(path.join(templateDirectory, markdownTemplates[0]!), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function replaceMarkdownSection(template: string, heading: string, sectionBody: string): string {
  const lines = template.split(/\r?\n/);
  const headingLine = `### ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) {
    return template;
  }
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("### ")) {
      endIndex = index;
      break;
    }
  }
  const replacementLines = [headingLine, ...sectionBody.trimEnd().split("\n"), ""];
  lines.splice(startIndex, endIndex - startIndex, ...replacementLines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function inferPublicationType(changedFiles: string[]): "Feature" | "Refactor / Cleanup" | "Chore (deps/infra/docs)" {
  if (changedFiles.every((file) => /(^|\/)(tests?|__tests__)\//.test(file) || /test/i.test(path.basename(file)))) {
    return "Refactor / Cleanup";
  }
  if (changedFiles.every((file) => /\.(md|txt|yml|yaml|json)$/.test(file))) {
    return "Chore (deps/infra/docs)";
  }
  return "Feature";
}

function issueReferenceRange(baseRef: string, candidateCommit: string): string {
  return `${baseRef}..${candidateCommit}`;
}

function extractIssueReferenceLines(commitMessages: string): string[] {
  const seen = new Set<string>();
  const references: string[] = [];
  for (const commitMessage of commitMessages.split("\u0000")) {
    for (const rawLine of commitMessage.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (!/(?:^|[\s(])(?:[A-Za-z0-9_.-]+\/)?#\d+\b/.test(line)) {
        continue;
      }
      if (!seen.has(line)) {
        seen.add(line);
        references.push(line);
      }
    }
  }
  return references;
}

async function listCandidateIssueReferences(
  repoPath: string,
  candidateCommit: string,
  sourceBranch: string,
): Promise<string[]> {
  let baseRef = sourceBranch;
  try {
    const mergeBase = await readGitStdout(repoPath, ["merge-base", sourceBranch, candidateCommit]);
    if (mergeBase) {
      baseRef = mergeBase;
    }
  } catch {
    // Fall back to the named source branch range when merge-base cannot be resolved.
  }

  const { stdout } = await execFileAsync("git", [
    "-C",
    repoPath,
    "log",
    "--format=%B%x00",
    issueReferenceRange(baseRef, candidateCommit),
  ]);
  return extractIssueReferenceLines(stdout);
}

export function renderPullRequestBody(
  template: string | undefined,
  spec: SpecDocument,
  summary: string,
  candidateCommit: string,
  changedFiles: string[],
  issueReferences: string[] = [],
): string {
  const summaryBlock = [
    `${summary}`,
    "",
    `Spec: ${spec.relFromSpecs}`,
    `Commit: ${candidateCommit}`,
    ...(issueReferences.length > 0 ? ["", ...issueReferences] : []),
  ].join("\n");

  if (!template) {
    return summaryBlock;
  }

  const hasUiChanges = changedFiles.some((file) => /\.(tsx?|jsx?|css|scss|sass|less|vue|html)$/.test(file));
  const hasMigrations = changedFiles.some((file) => /(^|\/)migrations\//.test(file));
  const hasNewPackages = changedFiles.some((file) =>
    ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "requirements.txt", "pyproject.toml"]
      .includes(path.basename(file)));
  const hasAutomatedTestChanges = changedFiles.some((file) =>
    /(^|\/)(tests?|__tests__)\//.test(file) || /test/i.test(path.basename(file)));
  const hasLintOrTypeVerification = spec.verificationCommands.some((command) =>
    /\b(lint|eslint|ruff|mypy|pyright|tsc|typecheck|prettier|format)\b/i.test(command));
  const publicationType = inferPublicationType(changedFiles);
  const blastRadius = changedFiles.length <= 3 ? "Low" : changedFiles.length <= 8 ? "Medium" : "High";

  let body = template;
  body = replaceMarkdownSection(body, "Summary", `${summaryBlock}\n`);
  body = replaceMarkdownSection(
    body,
    "UI?",
    [
      `- [${hasUiChanges ? " " : "x"}] No UI changes`,
      `- [${hasUiChanges ? "x" : " "}] UI-related (uncomment “Screenshots” below)`,
    ].join("\n"),
  );
  body = replaceMarkdownSection(
    body,
    "Type",
    [
      `- [${publicationType === "Feature" ? "x" : " "}] Feature`,
      `- [${publicationType === "Refactor / Cleanup" ? "x" : " "}] Refactor / Cleanup`,
      `- [${publicationType === "Chore (deps/infra/docs)" ? "x" : " "}] Chore (deps/infra/docs)`,
      "- [ ] UI polish (visual/non-functional)",
      "- [ ] Bugfix",
      "- [ ] Performance",
    ].join("\n"),
  );
  body = replaceMarkdownSection(
    body,
    "Risk / Impact",
    [
      "- **Blast radius**:",
      `  - [${blastRadius === "Low" ? "x" : " "}] Low`,
      `  - [${blastRadius === "Medium" ? "x" : " "}] Medium`,
      `  - [${blastRadius === "High" ? "x" : " "}] High`,
      "- **Migrations**:",
      `  - [${hasMigrations ? "x" : " "}] Yes`,
      `  - [${hasMigrations ? " " : "x"}] No`,
      "- **New packages**:",
      `  - [${hasNewPackages ? "x" : " "}] Yes`,
      `  - [${hasNewPackages ? " " : "x"}] No`,
    ].join("\n"),
  );
  body = replaceMarkdownSection(
    body,
    "Testing",
    [
      `- [${hasAutomatedTestChanges ? "x" : " "}] Automated tests added/updated`,
      "- [ ] Manual verification of happy **and** unhappy paths",
      `- [${hasLintOrTypeVerification ? "x" : " "}] Lint/type/format pass locally`,
    ].join("\n"),
  );
  return body.trimEnd();
}

export async function publishApprovedSpec(
  repoPath: string,
  spec: SpecDocument,
  summary: string,
  candidateCommit: string,
): Promise<PublicationResult> {
  const branch = spec.branchInstructions.createBranch;
  const remote = "origin";
  await execTool("git", ["-C", repoPath, "push", "-u", remote, branch], repoPath);

  const repoFullName = await githubRepoNameWithOwner(repoPath);
  const baseBranch = spec.branchInstructions.prTarget ?? spec.branchInstructions.sourceBranch;
  const shouldCreatePr = spec.branchInstructions.createPr ?? true;
  const draft = spec.branchInstructions.draftPr ?? true;
  const labels = await resolveGithubLabelNames(
    repoPath,
    repoFullName,
    [...new Set(["Prototype", ...(spec.branchInstructions.labels ?? [])])],
  );
  const template = await loadPullRequestTemplate(repoPath);
  const changedFiles = await listCandidateChangedFiles(repoPath, candidateCommit, spec.branchInstructions.sourceBranch)
    .catch(() => []);
  const issueReferences = await listCandidateIssueReferences(repoPath, candidateCommit, spec.branchInstructions.sourceBranch)
    .catch(() => []);
  const body = renderPullRequestBody(template, spec, summary, candidateCommit, changedFiles, issueReferences);

  if (!shouldCreatePr) {
    return {
      branch,
      remote,
      prCreated: false,
      draft,
      labels,
    };
  }

  if (!(await remoteBranchExists(repoPath, remote, baseBranch))) {
    throw new Error(`PR target branch ${baseBranch} does not exist on ${remote}. Push it first or change the spec PR target.`);
  }

  let existing = (await listPullRequestsForBranch(repoPath, repoFullName, branch))[0];
  let prCreated = false;
  if (!existing) {
    const createArgs = [
      "pr",
      "create",
      "--repo",
      repoFullName,
      "--head",
      branch,
      "--base",
      baseBranch,
      "--title",
      spec.title,
      "--body",
      body,
    ];
    if (draft) {
      createArgs.push("--draft");
    }
    for (const label of labels) {
      createArgs.push("--label", label);
    }
    await execTool("gh", createArgs, repoPath);
    existing = (await listPullRequestsForBranch(repoPath, repoFullName, branch))[0];
    if (!existing) {
      throw new Error(`Pull request creation succeeded but no PR was found for branch ${branch}.`);
    }
    prCreated = true;
  } else {
    const editArgs = [
      "pr",
      "edit",
      "--repo",
      repoFullName,
      String(existing.number),
      "--base",
      baseBranch,
      "--title",
      spec.title,
      "--body",
      body,
    ];
    for (const label of labels) {
      editArgs.push("--add-label", label);
    }
    await execTool("gh", editArgs, repoPath);
  }

  return {
    branch,
    remote,
    prNumber: existing.number,
    prUrl: existing.url,
    prCreated,
    draft: draft || existing.isDraft,
    labels,
  };
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

export async function runVerificationCommands(
  repoPath: string,
  featureBranch: string,
  commands: string[],
): Promise<VerificationRun> {
  const startingBranch = await readGitBranch(repoPath);
  const startingCommit = await readGitStdout(repoPath, ["rev-parse", "HEAD"]);
  const commandResults: VerificationRun["commands"] = [];

  if (commands.length === 0) {
    return {
      repoPath,
      featureBranch,
      startingBranch,
      startingCommit,
      restoredBranch: startingBranch,
      commands: commandResults,
      summary: `No verification commands were declared for ${featureBranch}.`,
      succeeded: true,
    };
  }

  let switchedToFeature = false;
  try {
    await checkoutGitRef(repoPath, featureBranch);
    switchedToFeature = true;
    for (const command of commands) {
      const result = await runShellCommand(repoPath, command);
      commandResults.push({
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  } finally {
    if (switchedToFeature) {
      if (startingBranch) {
        await checkoutGitRef(repoPath, startingBranch);
      } else {
        await checkoutDetachedCommit(repoPath, startingCommit);
      }
    }
  }

  const succeeded = commandResults.every((result) => result.exitCode === 0);
  return {
    repoPath,
    featureBranch,
    startingBranch,
    startingCommit,
    restoredBranch: startingBranch,
    commands: commandResults,
    summary: succeeded
      ? `Ran ${commandResults.length} verification command(s) on ${featureBranch}.`
      : `Ran ${commandResults.length} verification command(s) on ${featureBranch} with failures.`,
    succeeded,
  };
}

export async function ensureSpecWorktree(
  paths: RuntimePaths,
  spec: SpecDocument,
  repoPath: string,
): Promise<string> {
  const worktreePath = path.join(paths.worktreesRoot, spec.specId);
  await execFileAsync("git", ["-C", repoPath, "worktree", "prune", "--expire", "now"]);
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
  baseRef?: string,
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
    const committedFiles = await listCandidateChangedFiles(worktreePath, report.commitHash, baseRef);
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

export async function markSpecDone(
  paths: RuntimePaths,
  spec: SpecDocument,
  summary: string,
  candidateCommit?: string,
): Promise<string> {
  const state = (await loadRunState(paths, spec.specId)) ?? initialRunState(spec, false);
  state.specRel = spec.relFromSpecs;
  state.status = "done";
  state.lastCommit = candidateCommit;
  state.lastError = undefined;
  state.updatedAt = new Date().toISOString();
  state.legacyDoneDetected = false;
  state.invalidationReason = undefined;
  await saveRunState(paths, state);
  return saveDoneReport(paths, spec, summary, candidateCommit);
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
