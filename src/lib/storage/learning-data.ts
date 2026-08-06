import { type DBSchema, type IDBPDatabase, openDB } from "idb";

const DATABASE_NAME = "lexicon-workbench";
const DATABASE_VERSION = 1;
const BACKUP_VERSION = 1 as const;
export const HISTORY_LIST_LIMIT = 100;

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
  preferences: LearningPreferences;
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

function database(): Promise<IDBPDatabase<LearningDataSchema>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable in this environment."));
  }

  databasePromise ??= openDB<LearningDataSchema>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db) {
      const history = db.createObjectStore("history", { keyPath: "key" });
      history.createIndex("by-visited-at", "visitedAt");

      const favorites = db.createObjectStore("favorites", { keyPath: "key" });
      favorites.createIndex("by-created-at", "createdAt");

      const notes = db.createObjectStore("notes", { keyPath: "key" });
      notes.createIndex("by-updated-at", "updatedAt");

      db.createObjectStore("preferences", { keyPath: "key" });
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
    const [history, favorites, notes, preferences] = await Promise.all([
      db.getAll("history"),
      db.getAll("favorites"),
      db.getAll("notes"),
      this.getPreferences(),
    ]);

    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      history,
      favorites,
      notes,
      preferences,
    };
  },

  async import(backup: LearningDataBackup, replace = false): Promise<void> {
    if (backup.version !== BACKUP_VERSION) {
      throw new Error(`Unsupported learning-data backup version: ${backup.version}`);
    }

    const db = await database();
    const transaction = db.transaction(
      ["history", "favorites", "notes", "preferences"],
      "readwrite",
    );

    if (replace) {
      await Promise.all([
        transaction.objectStore("history").clear(),
        transaction.objectStore("favorites").clear(),
        transaction.objectStore("notes").clear(),
        transaction.objectStore("preferences").clear(),
      ]);
    }

    await Promise.all([
      ...backup.history.map((record) => transaction.objectStore("history").put(record)),
      ...backup.favorites.map((record) =>
        transaction.objectStore("favorites").put(record),
      ),
      ...backup.notes.map((record) => transaction.objectStore("notes").put(record)),
      transaction.objectStore("preferences").put(backup.preferences),
    ]);
    await transaction.done;
  },
};
