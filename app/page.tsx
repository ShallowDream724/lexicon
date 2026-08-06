import {
  DictionaryWorkspace,
  type WorkspaceInitialRoute,
} from "@/src/features/dictionary/components/DictionaryWorkspace";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: HomeProps) {
  const parameters = (await searchParams) ?? {};
  const entryId = firstParameter(parameters.entry)?.trim();
  const query = firstParameter(parameters.q)?.trim();
  const initialRoute: WorkspaceInitialRoute = entryId
    ? { kind: "entry", entryId }
    : query
      ? { kind: "query", query }
      : { kind: "home" };

  return <DictionaryWorkspace initialRoute={initialRoute} />;
}
