#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { RalphRunOptions, SupervisorOutcome, WorkflowProgressEvent } from "./types.js";
import { executeSpec } from "./workflow.js";
import { buildRuntimePaths, defaultWorkspaceRoot, ensureRuntimePaths, listRunStates, runEventLogPath, runtimeSummary } from "./runtime.js";
import { createSampleSpecFile, discoverSpecPaths, parseSpecFile } from "./specs.js";

export interface ParsedArgs {
  command: "run" | "status" | "inspect" | "create-spec";
  specFilters: string[];
  workspaceRoot: string | undefined;
  model: string;
  maxIterations: number;
  dryRun: boolean;
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

export function parseArgs(argv: string[]): ParsedArgs {
  const [firstToken, ...remainingTokens] = argv;
  const hasExplicitCommand =
    firstToken === "run" || firstToken === "status" || firstToken === "inspect" || firstToken === "create-spec";
  let parseError =
    firstToken && !hasExplicitCommand && !firstToken.startsWith("--") && !looksLikeSpecFilter(firstToken)
      ? `Unknown command: ${firstToken}`
      : undefined;
  const command: ParsedArgs["command"] =
    firstToken === "status" || firstToken === "inspect" || firstToken === "create-spec" ? firstToken : "run";
  const rest = hasExplicitCommand ? remainingTokens : parseError ? remainingTokens : argv;
  const args: ParsedArgs = {
    command,
    specFilters: [],
    model: "gpt-5.3-codex",
    maxIterations: 3,
    dryRun: false,
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
    if (token === "--workspace-root") {
      args.workspaceRoot = rest[index + 1];
      index += 1;
      continue;
    }
    if (token === "--model") {
      args.model = rest[index + 1] ?? args.model;
      index += 1;
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
    if (token === "--dry-run") {
      args.dryRun = true;
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
    args.specFilters.push(token);
  }

  if (parseError) {
    args.parseError = parseError;
  }
  return args;
}

export async function runCommand(parsed: ParsedArgs, deps: CommandDependencies = {}): Promise<number> {
  if (parsed.parseError) {
    console.error(`${parsed.parseError}. Use one of: run, status, inspect, create-spec.`);
    return 1;
  }

  const projectRoot = process.cwd();
  const workspaceRoot = parsed.workspaceRoot
    ? path.resolve(parsed.workspaceRoot)
    : defaultWorkspaceRoot(projectRoot);
  const paths = buildRuntimePaths(projectRoot, workspaceRoot);
  await ensureRuntimePaths(paths);

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
  const selected = parsed.specFilters.length > 0
    ? specPaths.filter((specPath) => parsed.specFilters.some((filter) => specPath.includes(filter)))
    : specPaths;

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
  console.log(`Running ${selected.length} spec(s) with model=${parsed.model} maxIterations=${parsed.maxIterations}`);
  for (const [index, relSpec] of selected.entries()) {
    const spec = await parseSpecFile(projectRoot, workspaceRoot, relSpec);
    const specIndex = index + 1;
    console.log(`\n[${specIndex}/${selected.length}] ${spec.specId} :: ${spec.title}`);
    let printedLogPath = false;
    try {
      const outcome = await executeSpecFn(paths, options, spec, {
        onProgress: (event): void => {
          if (!printedLogPath) {
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
