import process from "node:process";

const payload = JSON.parse(await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => resolve(text || "{}"));
}));

const message = String(payload?.last_assistant_message ?? "");
const soundsDone = /\b(done|complete|completed|ready)\b/i.test(message);
const mentionsVerification = /\b(test|verify|verification|commit)\b/i.test(message);

if (soundsDone && !mentionsVerification) {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "Before stopping, summarize the verification evidence and the exact commit or changed files.",
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ continue: true }));
