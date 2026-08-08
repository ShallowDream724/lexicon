import {
  DictionaryWorkspace,
  type WorkspaceInitialRoute,
} from "@/src/features/dictionary/components/DictionaryWorkspace";
import { parseWorkspaceRoute } from "@/src/features/dictionary/workspace-route";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: HomeProps) {
  const parameters = (await searchParams) ?? {};
  const routeParameters = new URLSearchParams();
  for (const key of ["entry", "q", "scope", "etymology", "article"]) {
    const value = firstParameter(parameters[key])?.trim();
    if (value) {
      routeParameters.set(key, value);
    }
  }
  const initialRoute: WorkspaceInitialRoute = parseWorkspaceRoute(routeParameters);

  return <DictionaryWorkspace initialRoute={initialRoute} />;
}
