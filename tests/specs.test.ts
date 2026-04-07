import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { discoverSpecPaths, parseSpecFile } from "../src/specs.js";
import { defaultWorkspaceRoot } from "../src/runtime.js";

const projectRoot = process.cwd();
const workspaceRoot = defaultWorkspaceRoot(projectRoot);

test("discoverSpecPaths ignores legacy state directories", async () => {
  const specs = await discoverSpecPaths(path.join(projectRoot, "specs"));
  assert.ok(specs.includes("1001-invoice-finalized-date-field.md"));
  assert.ok(specs.includes("10326-invoice-run-failed-debate-synthesis.md"));
  assert.ok(!specs.some((item) => item.startsWith("done/")));
  assert.ok(!specs.some((item) => item.startsWith("plans/")));
});

test("parseSpecFile preserves existing spec format", async () => {
  const spec = await parseSpecFile(projectRoot, workspaceRoot, "1001-invoice-finalized-date-field.md");
  assert.equal(spec.repo, "zemtu");
  assert.equal(spec.workdir, "zemtu");
  assert.equal(spec.branchInstructions.sourceBranch, "dev");
  assert.equal(spec.branchInstructions.createBranch, "feature/invoice_items_shifting/1001_add_finalized_date_field");
  assert.ok(spec.acceptanceCriteria.some((item) => item.includes("finalized_date")));
  assert.equal(spec.verificationCommands[0], "docker compose run --rm django python manage.py test billing.models.tests.tests_invoice --keep");
});
