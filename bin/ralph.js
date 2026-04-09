#!/usr/bin/env node

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const launchStrategies = [
  {
    kind: "tsx",
    entry: new URL("../src/cli.ts", import.meta.url),
    loader: new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
  },
  {
    kind: "module",
    entry: new URL("../dist/src/cli.js", import.meta.url),
  },
  {
    kind: "tsx",
    entry: new URL("../lib/node_modules/ralph/src/cli.ts", import.meta.url),
    loader: new URL("../lib/node_modules/ralph/node_modules/tsx/dist/loader.mjs", import.meta.url),
  },
  {
    kind: "module",
    entry: new URL("../lib/node_modules/ralph/dist/src/cli.js", import.meta.url),
  },
];

async function urlExists(url) {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

async function resolveLaunchStrategy() {
  for (const strategy of launchStrategies) {
    try {
      if (!(await urlExists(strategy.entry))) {
        continue;
      }
      if (strategy.kind === "tsx" && !(await urlExists(strategy.loader))) {
        continue;
      }
      return strategy;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not locate Ralph CLI entrypoint. Expected a source or dist entrypoint relative to the launcher.",
  );
}

const launchStrategy = await resolveLaunchStrategy();

if (launchStrategy.kind === "tsx") {
  const child = spawn(
    process.execPath,
    ["--import", fileURLToPath(launchStrategy.loader), fileURLToPath(launchStrategy.entry), ...process.argv.slice(2)],
    {
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { parseArgs, runCommand } = await import(launchStrategy.entry.href);

  runCommand(parseArgs(process.argv.slice(2)))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
