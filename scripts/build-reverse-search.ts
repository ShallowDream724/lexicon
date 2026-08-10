import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  BundledBilingualAdapter,
  DictionaryAdapterRegistry,
} from "../packages/adapters/src/index";
import {
  projectCanonicalEntrySearchDocuments,
  type SearchDocument,
} from "../packages/dictionary-search/src/index";
import { enrichSearchDocumentsWithObservedHeadwordForms } from "../packages/dictionary-search/src/build-headword-forms";

type Options = {
  database: string;
  output: string;
  dictionaryId: string;
  adapterId: string;
  replace: boolean;
};

function parseOptions(args: string[]): Options {
  const options: Options = {
    database: resolve("data/dictionary.db"),
    output: resolve("data/reverse-search.db"),
    dictionaryId: "core-english-zh",
    adapterId: "bundled-bilingual",
    replace: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = args[index + 1];
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    if (argument === "--database") {
      options.database = resolve(value);
    } else if (argument === "--output") {
      options.output = resolve(value);
    } else if (argument === "--dictionary-id") {
      options.dictionaryId = value.trim();
    } else if (argument === "--adapter") {
      options.adapterId = value.trim();
    } else {
      throw new Error(`Unknown option ${argument}.`);
    }
    index += 1;
  }
  if (!options.dictionaryId || !options.adapterId) {
    throw new Error("Dictionary and adapter ids must not be empty.");
  }
  return options;
}

function goProcess(args: string[]): ChildProcessWithoutNullStreams {
  return spawn("go", ["-C", "services/dictionary-api", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function writeDocuments(
  process: ChildProcessWithoutNullStreams,
  documents: readonly SearchDocument[],
): Promise<number> {
  if (!documents.length) {
    return 0;
  }
  const chunk = `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdin.write(chunk, "utf8", (error) => {
      if (error) {
        rejectWrite(error);
      } else {
        resolveWrite();
      }
    });
  });
  return Buffer.byteLength(chunk);
}

function completion(process: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  let stderr = "";
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 64 * 1024) {
      stderr = stderr.slice(-64 * 1024);
    }
  });
  return new Promise((resolveCompletion, rejectCompletion) => {
    process.once("error", rejectCompletion);
    process.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCompletion();
        return;
      }
      const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
      rejectCompletion(new Error(`${label} failed: ${detail}`));
    });
  });
}

async function build(options: Options): Promise<void> {
  const registry = new DictionaryAdapterRegistry().register(
    new BundledBilingualAdapter({ dictionaryId: options.dictionaryId }),
  );
  const adapter = registry.get(options.adapterId);
  if (!adapter) {
    throw new Error(`Dictionary adapter "${options.adapterId}" is not registered.`);
  }

  const exporter = goProcess([
    "run",
    "./cmd/dictionary-envelope-export",
    "-db",
    options.database,
  ]);
  const importerArgs = [
    "run",
    "./cmd/reverse-search-import",
    "-db",
    options.database,
    "-output",
    options.output,
  ];
  if (options.replace) {
    importerArgs.push("-replace");
  }
  const importer = goProcess(importerArgs);
  const exporterDone = completion(exporter, "dictionary envelope export");
  const importerDone = completion(importer, "reverse-search import");
  let processFailure: unknown;
  importer.stdin.on("error", (error) => {
    processFailure ??= error;
    exporter.kill();
  });
  void exporterDone.catch((error) => {
    processFailure = error;
    importer.stdin.destroy();
  });
  void importerDone.catch((error) => {
    processFailure = error;
    exporter.kill();
  });

  let entryCount = 0;
  let documentCount = 0;
  let projectedBytes = 0;
  try {
    const lines = createInterface({ input: exporter.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const entry = adapter.parse(JSON.parse(line));
      const documents = enrichSearchDocumentsWithObservedHeadwordForms(
        entry,
        projectCanonicalEntrySearchDocuments(entry),
      );
      projectedBytes += await writeDocuments(importer, documents);
      if (processFailure) {
        throw processFailure;
      }
      entryCount += 1;
      documentCount += documents.length;
      if (entryCount % 5_000 === 0) {
        process.stderr.write(`Projected ${entryCount.toLocaleString("en-US")} entries.\n`);
      }
    }
    importer.stdin.end();
    await Promise.all([exporterDone, importerDone]);
  } catch (error) {
    exporter.kill();
    importer.kill();
    importer.stdin.destroy();
    await Promise.allSettled([exporterDone, importerDone]);
    throw error;
  }
  process.stderr.write(
    `Built ${options.output} from ${entryCount.toLocaleString("en-US")} entries, ` +
      `${documentCount.toLocaleString("en-US")} documents, and ` +
      `${projectedBytes.toLocaleString("en-US")} projected bytes.\n`,
  );
}

const options = parseOptions(process.argv.slice(2));
await build(options);
