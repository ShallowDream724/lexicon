import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "runtime-assets.json");
const defaultTargetDirectory = join(repositoryRoot, "data");
const sha256Pattern = /^[a-f0-9]{64}$/;
const assetKinds = new Map([
  ["database", /\.db$/],
  ["headword-audio", /^headword-audio\.zip$/],
]);

export function validateManifest(value) {
  if (!value || value.schemaVersion !== 2 || typeof value.releaseTag !== "string") {
    throw new Error("runtime asset manifest has an unsupported schema");
  }
  const baseUrl = new URL(value.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("runtime asset base URL must use HTTPS");
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    throw new Error("runtime asset manifest contains no assets");
  }
  const names = new Set();
  for (const asset of value.assets) {
    const filePattern = assetKinds.get(asset?.kind);
    if (
      !asset ||
      !filePattern ||
      typeof asset.file !== "string" ||
      basename(asset.file) !== asset.file ||
      !filePattern.test(asset.file) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !Number.isSafeInteger(asset.records) ||
      asset.records <= 0 ||
      (asset.kind === "database" && (!Number.isSafeInteger(asset.runtimeSchema) || asset.runtimeSchema <= 0)) ||
      (asset.primarySha256 !== undefined &&
        (typeof asset.primarySha256 !== "string" || !sha256Pattern.test(asset.primarySha256))) ||
      typeof asset.sha256 !== "string" ||
      !sha256Pattern.test(asset.sha256)
    ) {
      throw new Error("runtime asset manifest contains an invalid asset");
    }
    if (names.has(asset.file)) {
      throw new Error(`runtime asset manifest repeats ${asset.file}`);
    }
    names.add(asset.file);
  }
  const dictionary = value.assets.find((asset) => asset.file === "dictionary.db");
  const reverseSearch = value.assets.find((asset) => asset.file === "reverse-search.db");
  if (
    reverseSearch &&
    (!dictionary || reverseSearch.primarySha256 !== dictionary.sha256)
  ) {
    throw new Error("reverse-search.db must identify the bundled dictionary.db fingerprint");
  }
  return value;
}

async function loadManifest() {
  return validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
}

async function fingerprint(path) {
  const details = await stat(path);
  if (!details.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return { bytes: details.size, sha256: digest.digest("hex") };
}

function matches(asset, fingerprintValue) {
  return asset.bytes === fingerprintValue.bytes && asset.sha256 === fingerprintValue.sha256;
}

function assetUrl(baseUrl, file) {
  const url = new URL(encodeURIComponent(file), baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("runtime asset URL must use HTTPS");
  }
  return url;
}

async function fetchAsset(url, timeout) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) {
        return response;
      }
      const error = new Error(`download failed with HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error?.retryable === false) {
        throw error;
      }
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
    }
  }
  throw lastError;
}

async function download(asset, baseUrl, targetDirectory, replace) {
  const destination = join(targetDirectory, asset.file);
  try {
    const current = await fingerprint(destination);
    if (matches(asset, current)) {
      console.log(`verified ${asset.file}`);
      return;
    }
    if (!replace) {
      throw new Error(`${asset.file} already exists with a different checksum; rerun with --replace to replace it`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const temporary = join(targetDirectory, `.${asset.file}.${process.pid}.part`);
  await rm(temporary, { force: true });
  try {
    const timeout = asset.bytes > 512 * 1024 * 1024 ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;
    console.log(`downloading ${asset.file}`);
    const response = await fetchAsset(assetUrl(baseUrl, asset.file), timeout);
    if (!response.body) {
      throw new Error(`download for ${asset.file} returned no body`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength !== asset.bytes) {
      throw new Error(`download size for ${asset.file} is ${contentLength}, expected ${asset.bytes}`);
    }
    const digest = createHash("sha256");
    let bytes = 0;
    let nextProgress = 25;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        digest.update(chunk);
        const progress = Math.floor((bytes / asset.bytes) * 100);
        if (progress >= nextProgress && nextProgress < 100) {
          console.log(`${asset.file}: ${nextProgress}%`);
          nextProgress += 25;
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: "wx" }));
    const downloaded = { bytes, sha256: digest.digest("hex") };
    if (!matches(asset, downloaded)) {
      throw new Error(`checksum verification failed for ${asset.file}`);
    }
    if (replace) {
      await rm(destination, { force: true });
    }
    await rename(temporary, destination);
    console.log(`downloaded ${asset.file} (${asset.bytes} bytes)`);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verify(asset, targetDirectory) {
  const result = await fingerprint(join(targetDirectory, asset.file));
  if (!matches(asset, result)) {
    throw new Error(`checksum verification failed for ${asset.file}`);
  }
  console.log(`verified ${asset.file}`);
}

async function main() {
  const [command = "download", ...options] = process.argv.slice(2);
  if (command !== "download" && command !== "verify") {
    throw new Error("usage: runtime-data.mjs <download|verify> [--replace]");
  }
  const unknown = options.filter((option) => option !== "--replace");
  if (unknown.length > 0) {
    throw new Error(`unknown option: ${unknown[0]}`);
  }
  const manifest = await loadManifest();
  const configuredBase = process.env.LEXICON_DATA_BASE_URL?.trim();
  const baseUrl = new URL(configuredBase ? `${configuredBase.replace(/\/$/, "")}/` : manifest.baseUrl);
  const configuredTarget = process.env.LEXICON_DATA_DIR?.trim();
  const targetDirectory = configuredTarget ? resolve(configuredTarget) : defaultTargetDirectory;
  if (baseUrl.protocol !== "https:") {
    throw new Error("LEXICON_DATA_BASE_URL must use HTTPS");
  }
  await mkdir(targetDirectory, { recursive: true });
  for (const asset of manifest.assets) {
    if (command === "verify") {
      await verify(asset, targetDirectory);
    } else {
      await download(asset, baseUrl, targetDirectory, options.includes("--replace"));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
