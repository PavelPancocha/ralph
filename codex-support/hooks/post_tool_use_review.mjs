import process from "node:process";

const payload = JSON.parse(await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => resolve(text || "{}"));
}));

const command = payload?.tool_input?.command ?? "";
const toolResponse = typeof payload?.tool_response === "string" ? payload.tool_response : JSON.stringify(payload?.tool_response ?? "");
const additionalContext = [];

if (/npm\s+install|pnpm\s+install|yarn\s+install/i.test(command)) {
  additionalContext.push("Dependency installation changed the workspace. Re-run focused verification before claiming completion.");
}

if (/git\s+commit/i.test(command)) {
  additionalContext.push("A commit was created. Confirm the branch is correct and verification still reflects HEAD.");
}

if (/error|failed/i.test(toolResponse)) {
  additionalContext.push("The previous command reported an error. Fix it or explain why it is expected.");
}

if (additionalContext.length === 0) {
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: additionalContext.join(" "),
  },
  systemMessage: "Ralph command review added follow-up guidance.",
}));
