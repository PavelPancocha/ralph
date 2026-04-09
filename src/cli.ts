#!/usr/bin/env node

import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { RalphRunOptions, SupervisorOutcome, WorkflowProgressEvent } from "./types.js";
import { executeSpec } from "./workflow.js";
import {
  buildRuntimePaths,
  defaultWorkspaceRoot,
  ensureRuntimePaths,
  listRunStates,
  peekRunState,
  runEventLogPath,
  runtimeSummary,
} from "./runtime.js";
import { createSampleSpecFile, discoverSpecPaths, parseSpecFile } from "./specs.js";

export interface ParsedArgs {
  command: "run" | "status" | "inspect" | "create-spec" | "help";
  specFilters: string[];
  workspaceRoot: string | undefined;
  model: string | undefined;
  maxIterations: number;
  dryRun: boolean;
  toSpec: string | undefined;
  inspectTarget: string | undefined;
  createSpecTarget: string | undefined;
  parseError?: string;
}

export interface CommandDependencies {
  executeSpec?: typeof executeSpec;
}

export function formatProgressLine(
  event: WorkflowProgressEvent,
  specIndex: number,
  specCount: number,
  maxIterations: number,
): string {
  const parts = [`[${specIndex}/${specCount}]`, event.phase.padEnd(12)];
  if (event.iteration) {
    parts.push(`iter ${event.iteration}/${maxIterations}`);
  }
  if (event.reviewer) {
    parts.push(`${event.reviewer} reviewer:`);
  }
  parts.push(event.summary);
  if (event.candidateCommit) {
    parts.push(`[${event.candidateCommit.slice(0, 12)}]`);
  }
  return parts.join(" ");
}

function looksLikeSpecFilter(token: string): boolean {
  return /(^|\/)\d{4,}/.test(token) || token.endsWith(".md");
}

function isHelpToken(token: string | undefined): boolean {
  return token === "--help" || token === "-h" || token === "help";
}

export function renderHelpText(): string {
  return [
    "Usage: ralph [run] [spec-filter...] [options]",
    "       ralph status",
    "       ralph inspect <spec-path>",
    "       ralph create-spec <spec-path>",
    "",
    "Commands: run, status, inspect, create-spec",
    "Options:",
    "  --dry-run, --dryrun        Preview matching specs without running Codex",
    "  --to <spec>                Run sequentially through the target spec, starting at the first not-done spec",
    "  --workspace-root <path>    Override the workspace root",
    "  --model <model>            Force all Ralph-managed roles to one model",
    "  --max-iterations <n>       Limit the internal review/fix loop",
    "  -h, --help                 Show this help",
  ].join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeProjectRoot(rootPath: string): Promise<boolean> {
  return (await pathExists(path.join(rootPath, "package.json"))) && (await pathExists(path.join(rootPath, "specs")));
}

async function resolveProjectRoot(invocationCwd: string): Promise<string> {
  if (await looksLikeProjectRoot(invocationCwd)) {
    return invocationCwd;
  }

  const nestedProjectRoot = path.join(invocationCwd, "ralph");
  if (await looksLikeProjectRoot(nestedProjectRoot)) {
    return nestedProjectRoot;
  }

  return invocationCwd;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [firstToken, ...remainingTokens] = argv;
  const helpRequested = argv.some((token) => isHelpToken(token));
  const hasExplicitCommand =
    firstToken === "run" || firstToken === "status" || firstToken === "inspect" || firstToken === "create-spec";
  let parseError =
    firstToken && !helpRequested && !hasExplicitCommand && !firstToken.startsWith("--") && !looksLikeSpecFilter(firstToken)
      ? `Unknown command: ${firstToken}`
      : undefined;
  const command: ParsedArgs["command"] = helpRequested
    ? "help"
    : firstToken === "status" || firstToken === "inspect" || firstToken === "create-spec"
      ? firstToken
      : "run";
  const rest = hasExplicitCommand ? remainingTokens : parseError ? remainingTokens : argv;
  const args: ParsedArgs = {
    command,
    specFilters: [],
    model: undefined,
    maxIterations: 3,
    dryRun: false,
    toSpec: undefined,
    workspaceRoot: undefined,
    inspectTarget: undefined,
    createSpecTarget: undefined,
    ...(parseError ? { parseError } : {}),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (isHelpToken(token)) {
      continue;
    }
    if (token === "--workspace-root") {
      args.workspaceRoot = rest[index + 1];
      index += 1;
      continue;
    }
    if (token === "--model") {
      const modelValue = rest[index + 1];
      if (!modelValue || modelValue.startsWith("--")) {
        parseError ??= "Missing --model value";
      } else {
        args.model = modelValue;
        index += 1;
      }
      continue;
    }
    if (token === "--max-iterations") {
      const parsedIterations = Number(rest[index + 1] ?? args.maxIterations);
      if (!Number.isInteger(parsedIterations) || parsedIterations < 1) {
        parseError ??= `Invalid --max-iterations value: ${rest[index + 1] ?? ""}`.trim();
      } else {
        args.maxIterations = parsedIterations;
      }
      index += 1;
      continue;
    }
    if (token === "--dry-run" || token === "--dryrun") {
      args.dryRun = true;
      continue;
    }
    if (token === "--to") {
      const toValue = rest[index + 1];
      if (!toValue || toValue.startsWith("--")) {
        parseError ??= "Missing --to value";
      } else {
        args.toSpec = toValue;
        index += 1;
      }
      continue;
    }
    if (args.command === "inspect" && !args.inspectTarget) {
      args.inspectTarget = token;
      continue;
    }
    if (args.command === "create-spec" && !args.createSpecTarget) {
      args.createSpecTarget = token;
      continue;
    }
    if (token.startsWith("--")) {
      parseError ??= `Unknown option: ${token}`;
      continue;
    }
    args.specFilters.push(token);
  }

  if (parseError) {
    args.parseError = parseError;
  }
  return args;
}

export async function runCommand(parsed: ParsedArgs, deps: CommandDependencies = {}): Promise<number> {
  if (parsed.parseError) {
    console.error(`${parsed.parseError}. Use --help for usage.`);
    return 1;
  }

  if (parsed.command === "help") {
    console.log(renderHelpText());
    return 0;
  }

  const projectRoot = await resolveProjectRoot(process.cwd());
  const workspaceRoot = parsed.workspaceRoot
    ? path.resolve(parsed.workspaceRoot)
    : defaultWorkspaceRoot(projectRoot);
  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  if (!(parsed.command === "run" && parsed.dryRun)) {
    await ensureRuntimePaths(paths);
  }

  if (parsed.command === "status") {
    const states = await listRunStates(paths);
    console.log(runtimeSummary(paths));
    console.log("");
    if (states.length === 0) {
      console.log("No run state found.");
      return 0;
    }
    for (const state of states) {
      console.log(`${state.specId}\t${state.status}\titeration=${state.currentIteration}\tcommit=${state.lastCommit ?? "-"}`);
    }
    return 0;
  }

  if (parsed.command === "inspect") {
    if (!parsed.inspectTarget) {
      console.error("inspect requires a spec path like 1001-example.md");
      return 1;
    }
    const spec = await parseSpecFile(projectRoot, workspaceRoot, parsed.inspectTarget);
    console.log(JSON.stringify(spec, null, 2));
    return 0;
  }

  if (parsed.command === "create-spec") {
    if (!parsed.createSpecTarget) {
      console.error("create-spec requires a target like 1234-example.md or area/1234-example.md");
      return 1;
    }
    const absolute = await createSampleSpecFile(projectRoot, parsed.createSpecTarget);
    console.log(`Created ${path.relative(projectRoot, absolute).replaceAll(path.sep, "/")}`);
    return 0;
  }

  const specPaths = await discoverSpecPaths(path.join(projectRoot, "specs"));
  const filtered = parsed.specFilters.length > 0
    ? specPaths.filter((specPath) => parsed.specFilters.some((filter) => specPath.includes(filter)))
    : specPaths;

  let selected = filtered;
  if (parsed.toSpec) {
    const matchingTargets = filtered.filter((specPath) => specPath.includes(parsed.toSpec as string));
    if (matchingTargets.length === 0) {
      console.error(`No specs matched --to ${parsed.toSpec}.`);
      return 1;
    }
    if (matchingTargets.length > 1) {
      console.error(`--to ${parsed.toSpec} is ambiguous: ${matchingTargets.join(", ")}`);
      return 1;
    }
    const targetPath = matchingTargets[0]!;
    const bounded = filtered.slice(0, filtered.indexOf(targetPath) + 1);
    let firstPendingIndex = bounded.length;
    for (const [index, relSpec] of bounded.entries()) {
      const specId = path.basename(relSpec, ".md");
      const state = await peekRunState(paths, specId);
      const legacyDonePath = path.join(projectRoot, "specs", "done", relSpec);
      const done = state?.status === "done" || (await pathExists(legacyDonePath));
      if (!done) {
        firstPendingIndex = index;
        break;
      }
    }
    if (firstPendingIndex === bounded.length) {
      console.log(`All specs through ${targetPath} are already done.`);
      return 0;
    }
    selected = bounded.slice(firstPendingIndex);
  }

  if (selected.length === 0) {
    console.error("No specs matched.");
    return 1;
  }

  const options: RalphRunOptions = {
    workspaceRoot,
    projectRoot,
    model: parsed.model,
    maxIterations: parsed.maxIterations,
    dryRun: parsed.dryRun,
    specFilters: parsed.specFilters,
  };
  const executeSpecFn = deps.executeSpec ?? executeSpec;

  let failures = 0;
  console.log(
    parsed.model
      ? `Running ${selected.length} spec(s) with model override=${parsed.model} maxIterations=${parsed.maxIterations}`
      : `Running ${selected.length} spec(s) with smart role policy maxIterations=${parsed.maxIterations}`,
  );
  for (const [index, relSpec] of selected.entries()) {
    const spec = await parseSpecFile(projectRoot, workspaceRoot, relSpec);
    const specIndex = index + 1;
    console.log(`\n[${specIndex}/${selected.length}] ${spec.specId} :: ${spec.title}`);
    let printedLogPath = false;
    try {
      const outcome = await executeSpecFn(paths, options, spec, {
        onProgress: (event): void => {
          if (!printedLogPath && !parsed.dryRun) {
            const logPath = runEventLogPath(paths, spec.specId, event.runId);
            console.log(`[${specIndex}/${selected.length}] logs         ${path.relative(projectRoot, logPath).replaceAll(path.sep, "/")}`);
            printedLogPath = true;
          }
          console.log(formatProgressLine(event, specIndex, selected.length, parsed.maxIterations));
        },
      });
      console.log(`[${specIndex}/${selected.length}] ${outcome.status.toUpperCase()}: ${outcome.summary}`);
      if (outcome.candidateCommit) {
        console.log(`[${specIndex}/${selected.length}] commit: ${outcome.candidateCommit}`);
      }
      if (outcome.status === "failed") {
        failures += 1;
      }
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[${specIndex}/${selected.length}] FAILED: ${message}`);
    }
  }

  return failures > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommand(parseArgs(process.argv.slice(2)))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
