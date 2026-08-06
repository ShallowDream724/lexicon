import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverPath = join(projectRoot, ".next", "standalone", "server.js");

let origin;
let serverProcess;
let serverOutput = "";

async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`standalone server exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`standalone server did not become ready:\n${serverOutput}`);
}

before(async () => {
  assert.equal(existsSync(serverPath), true, "run npm run build before the HTML tests");
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: dirname(serverPath),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      serverOutput += chunk;
    });
  }
  await waitForServer(origin);
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }
  serverProcess.kill();
  await Promise.race([
    once(serverProcess, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
});

async function render(pathname = "/") {
  return fetch(`${origin}${pathname}`, { headers: { accept: "text/html" } });
}

test("server-renders the anonymous dictionary workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Lexicon Workbench<\/title>/i);
  assert.match(html, /LEXICON/);
  assert.match(html, /输入要查询的单词或短语/);
  assert.match(html, /词典首页/);
  assert.match(html, /最近查询/);
  assert.match(html, /收藏词条/);
  assert.doesNotMatch(html, /com·ple·tion/);
  assert.doesNotMatch(html, /the act or process of finishing something/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
  assert.doesNotMatch(html, /登录|注册|二维码|下载App|VIP/);
});

test("server-renders deep links without flashing the home collection", async () => {
  const response = await render("/?entry=deep-link-entry");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /aria-label="正在加载词条"/);
  assert.doesNotMatch(html, /词典首页/);
  assert.doesNotMatch(html, /the act or process of finishing something/);
});
