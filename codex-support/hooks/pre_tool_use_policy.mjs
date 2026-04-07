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
const deniedPatterns = [
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-fd/i,
  /\brm\s+-rf\s+\/\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
];

for (const pattern of deniedPatterns) {
  if (pattern.test(command)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked command by Ralph policy: ${command}`,
      },
      systemMessage: "Ralph policy blocked a destructive command.",
    }));
    process.exit(0);
  }
}

process.exit(0);
