import type {
  EtymologyArticleResponse,
  EtymologyResourceSummary,
} from "../../../packages/enhancement-schema/src/index";

export function isArticleResponseForResource(
  response: EtymologyArticleResponse | undefined,
  resource: EtymologyResourceSummary | null,
  articleId: string | null | undefined,
): response is EtymologyArticleResponse {
  return Boolean(
    response &&
    resource &&
    articleId &&
    response.resourceId === resource.resourceId &&
    response.sourceVersion === resource.sourceVersion &&
    response.article.id === articleId,
  );
}
