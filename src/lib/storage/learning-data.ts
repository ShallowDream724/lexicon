import { type DBSchema, type IDBPDatabase, openDB } from "idb";

const DATABASE_NAME = "lexicon-workbench";
export const LEARNING_DATA_DATABASE_VERSION = 2;
export const LEARNING_DATA_BACKUP_VERSION = 2 as const;
const DATABASE_VERSION = LEARNING_DATA_DATABASE_VERSION;
const BACKUP_VERSION = LEARNING_DATA_BACKUP_VERSION;
export const HISTORY_LIST_LIMIT = 100;
export const QUERY_HISTORY_LIST_LIMIT = 100;

export type EntryIdentity = {
  dictionaryId: string;
  entryId: string;
};

export type HistoryRecord = EntryIdentity & {
  key: string;
  headword: string;
  visitedAt: number;
  visitCount: number;
};

export type FavoriteRecord = EntryIdentity & {
  key: string;
  headword: string;
  createdAt: number;
};

export type NoteRecord = EntryIdentity & {
  key: string;
  headword: string;
  text: string;
  updatedAt: number;
};

export type QueryHistoryRecord = {
  key: string;
  query: string;
  submittedAt: number;
  submitCount: number;
};

export type LearningPreferences = {
  key: "main";
  fontScale: "small" | "default" | "large";
  showTranslations: boolean;
  autoplayAccent: "off" | "british" | "american";
};

export type LearningDataBackup = {
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  history: HistoryRecord[];
  favorites: FavoriteRecord[];
  notes: NoteRecord[];
  queryHistory: QueryHistoryRecord[];
  preferences: LearningPreferences;
};

type LegacyLearningDataBackup = Omit<LearningDataBackup, "version" | "queryHistory"> & {
  version: 1;
};

interface LearningDataSchema extends DBSchema {
  history: {
    key: string;
    value: HistoryRecord;
    indexes: { "by-visited-at": number };
  };
  favorites: {
    key: string;
    value: FavoriteRecord;
    indexes: { "by-created-at": number };
  };
  notes: {
    key: string;
    value: NoteRecord;
    indexes: { "by-updated-at": number };
  };
  queryHistory: {
    key: string;
    value: QueryHistoryRecord;
    indexes: { "by-submitted-at": number };
  };
  preferences: {
    key: "main";
    value: LearningPreferences;
  };
}

const defaultPreferences: LearningPreferences = {
  key: "main",
  fontScale: "default",
  showTranslations: true,
  autoplayAccent: "off",
};

let databasePromise: Promise<IDBPDatabase<LearningDataSchema>> | undefined;

function entryKey({ dictionaryId, entryId }: EntryIdentity): string {
  return JSON.stringify([dictionaryId, entryId]);
}

export function nextHistoryRecord(
  identity: EntryIdentity & { headword: string },
  previous: HistoryRecord | undefined,
  visitedAt = Date.now(),
): HistoryRecord {
  return {
    key: entryKey(identity),
    dictionaryId: identity.dictionaryId,
    entryId: identity.entryId,
    headword: identity.headword,
    visitedAt,
    visitCount: (previous?.visitCount ?? 0) + 1,
  };
}

export function cleanQueryHistoryDisplay(query: string): string {
  return query.trim().replace(/\s+/gu, " ");
}

export function normalizeQueryHistoryKey(query: string): string {
  return cleanQueryHistoryDisplay(query)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function nextQueryHistoryRecord(
  query: string,
  previous: QueryHistoryRecord | undefined,
  submittedAt = Date.now(),
): QueryHistoryRecord | undefined {
  const displayQuery = cleanQueryHistoryDisplay(query);
  const key = normalizeQueryHistoryKey(displayQuery);
  if (!key) {
    return undefined;
  }

  return {
    key,
    query: displayQuery,
    submittedAt,
    submitCount: (previous?.submitCount ?? 0) + 1,
  };
}

export function sortQueryHistoryNewestFirst(
  records: readonly QueryHistoryRecord[],
): QueryHistoryRecord[] {
  return [...records].sort((left, right) => {
    if (left.submittedAt !== right.submittedAt) {
      return right.submittedAt - left.submittedAt;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

export function retainQueryHistoryRecords(
  records: readonly QueryHistoryRecord[],
  limit = QUERY_HISTORY_LIST_LIMIT,
): QueryHistoryRecord[] {
  return sortQueryHistoryNewestFirst(records).slice(0, Math.max(0, limit));
}

export function uniqueRecordKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => Boolean(key)))];
}

function database(): Promise<IDBPDatabase<LearningDataSchema>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this environment."));
  }

  databasePromise ??= openDB<LearningDataSchema>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const history = db.createObjectStore("history", { keyPath: "key" });
        history.createIndex("by-visited-at", "visitedAt");

        const favorites = db.createObjectStore("favorites", { keyPath: "key" });
        favorites.createIndex("by-created-at", "createdAt");

        const notes = db.createObjectStore("notes", { keyPath: "key" });
        notes.createIndex("by-updated-at", "updatedAt");

        db.createObjectStore("preferences", { keyPath: "key" });
      }

      if (oldVersion < 2 && !db.objectStoreNames.contains("queryHistory")) {
        const queryHistory = db.createObjectStore("queryHistory", { keyPath: "key" });
        queryHistory.createIndex("by-submitted-at", "submittedAt");
      }
    },
  });

  return databasePromise;
}

async function newestFirst<T>(
  storeName: "history" | "favorites" | "notes",
  indexName: "by-visited-at" | "by-created-at" | "by-updated-at",
  limit: number,
): Promise<T[]> {
  const db = await database();
  const transaction = db.transaction(storeName, "readonly");
  const index = transaction.store.index(indexName as never);
  const results: T[] = [];
  let cursor = await index.openCursor(null, "prev");

  while (cursor && results.length < limit) {
    results.push(cursor.value as T);
    cursor = await cursor.continue();
  }

  await transaction.done;
  return results;
}

export const learningData = {
  async recordVisit(
    identity: EntryIdentity & { headword: string },
  ): Promise<HistoryRecord> {
    const db = await database();
    const key = entryKey(identity);
    const transaction = db.transaction("history", "readwrite");
    const previous = await transaction.store.get(key);
    const record = nextHistoryRecord(identity, previous);
    await transaction.store.put(record);
    await transaction.done;
    return record;
  },

  listHistory(limit = HISTORY_LIST_LIMIT): Promise<HistoryRecord[]> {
    return newestFirst("history", "by-visited-at", limit);
  },

  async deleteHistory(keys: readonly string[]): Promise<void> {
    const uniqueKeys = uniqueRecordKeys(keys);
    if (!uniqueKeys.length) {
      return;
    }
    const db = await database();
    const transaction = db.transaction("history", "readwrite");
    await Promise.all(uniqueKeys.map((key) => transaction.store.delete(key)));
    await transaction.done;
  },

  async recordQueryHistory(query: string, submittedAt = Date.now()): Promise<QueryHistoryRecord | undefined> {
    const record = nextQueryHistoryRecord(query, undefined, submittedAt);
    if (!record) {
      return undefined;
    }

    const db = await database();
    const transaction = db.transaction("queryHistory", "readwrite");
    const previous = await transaction.store.get(record.key);
    const nextRecord = nextQueryHistoryRecord(query, previous, submittedAt);
    if (!nextRecord) {
      await transaction.done;
      return undefined;
    }

    await transaction.store.put(nextRecord);
    const allRecords = await transaction.store.getAll();
    const retained = retainQueryHistoryRecords(allRecords, QUERY_HISTORY_LIST_LIMIT);
    const retainedKeys = new Set(retained.map(({ key }) => key));
    await Promise.all(
      allRecords
        .filter(({ key }) => !retainedKeys.has(key))
        .map(({ key }) => transaction.store.delete(key)),
    );
    await transaction.done;
    return nextRecord;
  },

  async listQueryHistory(limit = QUERY_HISTORY_LIST_LIMIT): Promise<QueryHistoryRecord[]> {
    const db = await database();
    return retainQueryHistoryRecords(await db.getAll("queryHistory"), limit);
  },

  async deleteQueryHistory(key: string): Promise<void> {
    const db = await database();
    await db.delete("queryHistory", key);
  },

  async isFavorite(identity: EntryIdentity): Promise<boolean> {
    const db = await database();
    return Boolean(await db.get("favorites", entryKey(identity)));
  },

  async setFavorite(
    identity: EntryIdentity & { headword: string },
    favorite: boolean,
  ): Promise<boolean> {
    const db = await database();
    const key = entryKey(identity);
    if (!favorite) {
      await db.delete("favorites", key);
      return false;
    }

    await db.put("favorites", {
      key,
      dictionaryId: identity.dictionaryId,
      entryId: identity.entryId,
      headword: identity.headword,
      createdAt: Date.now(),
    });
    return true;
  },

  listFavorites(limit = 100): Promise<FavoriteRecord[]> {
    return newestFirst("favorites", "by-created-at", limit);
  },

  async removeFavorites(keys: readonly string[]): Promise<void> {
    const uniqueKeys = uniqueRecordKeys(keys);
    if (!uniqueKeys.length) {
      return;
    }
    const db = await database();
    const transaction = db.transaction("favorites", "readwrite");
    await Promise.all(uniqueKeys.map((key) => transaction.store.delete(key)));
    await transaction.done;
  },

  async getNote(identity: EntryIdentity): Promise<NoteRecord | undefined> {
    const db = await database();
    return db.get("notes", entryKey(identity));
  },

  async saveNote(
    identity: EntryIdentity & { headword: string },
    text: string,
  ): Promise<NoteRecord | undefined> {
    const db = await database();
    const key = entryKey(identity);
    const normalizedText = text.trim();
    if (!normalizedText) {
      await db.delete("notes", key);
      return undefined;
    }

    const note: NoteRecord = {
      key,
      dictionaryId: identity.dictionaryId,
      entryId: identity.entryId,
      headword: identity.headword,
      text: normalizedText,
      updatedAt: Date.now(),
    };
    await db.put("notes", note);
    return note;
  },

  listNotes(limit = 100): Promise<NoteRecord[]> {
    return newestFirst("notes", "by-updated-at", limit);
  },

  async deleteNotes(keys: readonly string[]): Promise<void> {
    const uniqueKeys = uniqueRecordKeys(keys);
    if (!uniqueKeys.length) {
      return;
    }
    const db = await database();
    const transaction = db.transaction("notes", "readwrite");
    await Promise.all(uniqueKeys.map((key) => transaction.store.delete(key)));
    await transaction.done;
  },

  async getPreferences(): Promise<LearningPreferences> {
    const db = await database();
    return (await db.get("preferences", "main")) ?? defaultPreferences;
  },

  async updatePreferences(
    update: Partial<Omit<LearningPreferences, "key">>,
  ): Promise<LearningPreferences> {
    const db = await database();
    const current = (await db.get("preferences", "main")) ?? defaultPreferences;
    const next = { ...current, ...update, key: "main" as const };
    await db.put("preferences", next);
    return next;
  },

  async export(): Promise<LearningDataBackup> {
    const db = await database();
    const [history, favorites, notes, queryHistory, preferences] = await Promise.all([
      db.getAll("history"),
      db.getAll("favorites"),
      db.getAll("notes"),
      db.getAll("queryHistory"),
      this.getPreferences(),
    ]);

    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      history,
      favorites,
      notes,
      queryHistory,
      preferences,
    };
  },

  async import(backup: LearningDataBackup | LegacyLearningDataBackup, replace = false): Promise<void> {
    const backupVersion = backup.version;
    if (backupVersion !== 1 && backupVersion !== BACKUP_VERSION) {
      throw new Error(`Unsupported learning-data backup version: ${String(backupVersion)}`);
    }

    const db = await database();
    const transaction = db.transaction(
      ["history", "favorites", "notes", "queryHistory", "preferences"],
      "readwrite",
    );
    const queryHistoryStore = transaction.objectStore("queryHistory");
    const importedQueryHistory =
      backup.version === BACKUP_VERSION ? retainQueryHistoryRecords(backup.queryHistory) : [];
    const existingQueryHistory =
      importedQueryHistory.length && !replace ? await queryHistoryStore.getAll() : [];
    const mergedQueryHistory = new Map(
      existingQueryHistory.map((record) => [record.key, record]),
    );
    for (const record of importedQueryHistory) {
      mergedQueryHistory.set(record.key, record);
    }
    const retainedQueryHistory = retainQueryHistoryRecords([...mergedQueryHistory.values()]);
    const retainedQueryHistoryKeys = new Set(retainedQueryHistory.map(({ key }) => key));

    if (replace) {
      await Promise.all([
        transaction.objectStore("history").clear(),
        transaction.objectStore("favorites").clear(),
        transaction.objectStore("notes").clear(),
        transaction.objectStore("queryHistory").clear(),
        transaction.objectStore("preferences").clear(),
      ]);
    }

    await Promise.all([
      ...backup.history.map((record) => transaction.objectStore("history").put(record)),
      ...backup.favorites.map((record) =>
        transaction.objectStore("favorites").put(record),
      ),
      ...backup.notes.map((record) => transaction.objectStore("notes").put(record)),
      ...existingQueryHistory
        .filter(({ key }) => !retainedQueryHistoryKeys.has(key))
        .map(({ key }) => queryHistoryStore.delete(key)),
      ...retainedQueryHistory.map((record) => queryHistoryStore.put(record)),
      transaction.objectStore("preferences").put(backup.preferences),
    ]);
    await transaction.done;
  },
};
