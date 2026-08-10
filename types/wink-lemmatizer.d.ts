declare module "wink-lemmatizer" {
  interface WinkLemmatizer {
    adjective(value: string): string;
    noun(value: string): string;
    verb(value: string): string;
  }

  const lemmatizer: WinkLemmatizer;
  export default lemmatizer;
}
