export type EtymologyRoute = {
  term: string;
  articleId?: string;
};

export type WorkspaceRoute =
  | { kind: "home" }
  | { kind: "query"; query: string }
  | { kind: "entry"; entryId: string; etymology?: EtymologyRoute }
  | { kind: "etymology"; etymology: EtymologyRoute };

type SearchParameters = Pick<URLSearchParams, "get">;

export function parseWorkspaceRoute(parameters: SearchParameters): WorkspaceRoute {
  const entryId = parameters.get("entry")?.trim();
  const query = parameters.get("q")?.trim();
  const term = parameters.get("etymology")?.trim();
  const articleId = parameters.get("article")?.trim() || undefined;

  if (entryId) {
    return {
      kind: "entry",
      entryId,
      ...(term ? { etymology: { term, articleId } } : {}),
    };
  }
  if (term) {
    return { kind: "etymology", etymology: { term, articleId } };
  }
  if (query) {
    return { kind: "query", query };
  }
  return { kind: "home" };
}

export function workspaceRouteUrl(pathname: string, route: WorkspaceRoute): string {
  const parameters = new URLSearchParams();
  if (route.kind === "entry") {
    parameters.set("entry", route.entryId);
    if (route.etymology) {
      parameters.set("etymology", route.etymology.term);
      if (route.etymology.articleId) {
        parameters.set("article", route.etymology.articleId);
      }
    }
  } else if (route.kind === "etymology") {
    parameters.set("etymology", route.etymology.term);
    if (route.etymology.articleId) {
      parameters.set("article", route.etymology.articleId);
    }
  } else if (route.kind === "query") {
    parameters.set("q", route.query);
  }

  const query = parameters.toString();
  return query ? `${pathname}?${query}` : pathname;
}
