import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimePaths, initialRunState } from "../src/runtime.js";

test("buildRuntimePaths places state under .ralph", () => {
  const paths = buildRuntimePaths("/tmp/ralph", "/tmp");
  assert.equal(paths.ralphRoot, "/tmp/ralph/.ralph");
  assert.equal(paths.worktreesRoot, "/tmp/ralph/.ralph/worktrees");
});

test("initialRunState starts queued when no legacy done marker exists", () => {
  const state = initialRunState(
    {
      specPath: "/tmp/specs/1001-example.md",
      relFromSpecs: "1001-example.md",
      relFromWorkspace: "ralph/specs/1001-example.md",
      specId: "1001-example",
      title: "1001 - Example",
      repo: "repo",
      workdir: "repo",
      branchInstructions: {
        sourceBranch: "dev",
        createBranch: "feature/example",
      },
      goal: "Goal",
      scopeIn: [],
      boundariesOut: [],
      constraints: [],
      dependencies: [],
      requiredReading: [],
      acceptanceCriteria: [],
      commitRequirements: [],
      verificationCommands: [],
      rawSections: {},
    },
    false,
  );
  assert.equal(state.status, "queued");
  assert.equal(state.currentIteration, 0);
});
