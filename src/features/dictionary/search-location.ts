import type { SearchDocumentLocation } from "../../../packages/dictionary-search/src/index";

export type SearchLocationAttributes = {
  "data-search-owner-id"?: string;
  "data-search-path"?: string;
};

export function searchLocationPathKey(path: readonly string[]): string {
  return path.map((segment) => encodeURIComponent(segment)).join("/");
}

export function searchLocationAttributes(
  location: SearchDocumentLocation | undefined,
  ownerId?: string,
): SearchLocationAttributes {
  const resolvedOwnerId = ownerId?.trim() || location?.ownerId?.trim();
  return {
    ...(resolvedOwnerId ? { "data-search-owner-id": resolvedOwnerId } : {}),
    ...(location?.path.length
      ? { "data-search-path": searchLocationPathKey(location.path) }
      : {}),
  };
}

export function searchLocationPathAttributes(
  location: SearchDocumentLocation | undefined,
): SearchLocationAttributes {
  return location?.path.length
    ? { "data-search-path": searchLocationPathKey(location.path) }
    : {};
}

export function searchLocationContains(
  container: SearchDocumentLocation | undefined,
  target: SearchDocumentLocation,
): boolean {
  if (!container || container.section !== target.section) {
    return false;
  }
  if (container.ownerId && target.ownerId && container.ownerId !== target.ownerId) {
    return false;
  }
  const containerPath = searchLocationPathKey(container.path);
  const targetPath = searchLocationPathKey(target.path);
  return containerPath === targetPath || Boolean(
    containerPath && targetPath.startsWith(`${containerPath}/`),
  );
}

function elementsWithAttribute(root: ParentNode, attribute: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`));
}

function elementById(root: ParentNode, id: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
    (element) => element.id === id,
  ) ?? null;
}

export function findSearchLocationElement(
  location: SearchDocumentLocation,
  root: ParentNode = document,
): HTMLElement | null {
  const targetPath = searchLocationPathKey(location.path);
  if (targetPath) {
    const candidates = elementsWithAttribute(root, "data-search-path");
    const exactCandidates = candidates.filter(
      (element) => element.dataset.searchPath === targetPath,
    );
    const exact = location.ownerId
      ? exactCandidates.find(
          (element) => element.dataset.searchOwnerId === location.ownerId,
        ) ?? exactCandidates.find((element) => !element.dataset.searchOwnerId)
      : exactCandidates[0];
    if (exact) {
      return exact;
    }
  }

  if (location.ownerId) {
    const owner = elementsWithAttribute(root, "data-search-owner-id").find(
      (element) => element.dataset.searchOwnerId === location.ownerId,
    );
    if (owner) {
      return owner;
    }
  }

  if (targetPath) {
    const candidates = elementsWithAttribute(root, "data-search-path");
    const ancestor = candidates
      .filter((element) => {
        const candidate = element.dataset.searchPath;
        return Boolean(candidate && targetPath.startsWith(`${candidate}/`));
      })
      .toSorted(
        (left, right) => (right.dataset.searchPath?.length ?? 0) - (left.dataset.searchPath?.length ?? 0),
      )[0];
    if (ancestor) {
      return ancestor;
    }
  }

  return elementById(root, location.section) ??
    (location.section === "grammar-usage" ? elementById(root, "definitions") : null);
}

export function scrollToSearchLocation(
  location: SearchDocumentLocation,
  root: ParentNode = document,
): HTMLElement | null {
  const target = findSearchLocationElement(location, root);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  return target;
}
