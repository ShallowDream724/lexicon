export type ResultPageSession<State> = {
  state: State;
  scrollY: number;
};

export type ResultPageSessionStore<State> = {
  read(key: string): ResultPageSession<State> | undefined;
  write(key: string, session: ResultPageSession<State>): void;
};

export function createResultPageSessionStore<State>(
  capacity = 3,
): ResultPageSessionStore<State> {
  const sessions = new Map<string, ResultPageSession<State>>();
  const boundedCapacity = Math.max(1, Math.floor(capacity));

  return {
    read(key) {
      const session = sessions.get(key);
      if (!session) {
        return undefined;
      }
      sessions.delete(key);
      sessions.set(key, session);
      return session;
    },
    write(key, session) {
      sessions.delete(key);
      sessions.set(key, session);
      while (sessions.size > boundedCapacity) {
        const oldestKey = sessions.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        sessions.delete(oldestKey);
      }
    },
  };
}
