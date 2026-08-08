export type LibrarySelectionAction =
  | { type: "toggle"; key: string }
  | { type: "select-all"; keys: readonly string[] }
  | { type: "clear" };

export function librarySelectionReducer(
  selectedKeys: ReadonlySet<string>,
  action: LibrarySelectionAction,
): Set<string> {
  if (action.type === "clear") {
    return new Set();
  }

  if (action.type === "select-all") {
    return new Set(action.keys);
  }

  const next = new Set(selectedKeys);
  if (next.has(action.key)) {
    next.delete(action.key);
  } else {
    next.add(action.key);
  }
  return next;
}
