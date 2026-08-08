import {
  DictionaryClientError,
  dictionarySearchQueryLimit,
  dictionarySearchQueryTooLongCode,
} from "../../lib/dictionary-client/client";

export function dictionarySearchErrorMessage(error: unknown): string {
  if (
    error instanceof DictionaryClientError &&
    error.code === dictionarySearchQueryTooLongCode
  ) {
    return `查询内容最多 ${dictionarySearchQueryLimit} 个字符，请缩短后重试`;
  }
  return "词典服务暂不可用";
}
