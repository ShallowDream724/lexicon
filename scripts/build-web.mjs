import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

const inheritedRevision =
  process.env.LEXICON_BUILD_REVISION?.trim() ||
  process.env.GITHUB_SHA?.trim();
const buildRevision =
  inheritedRevision ??
  `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
const nextCli = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextCli, "build"], {
  env: {
    ...process.env,
    LEXICON_BUILD_REVISION: buildRevision,
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
