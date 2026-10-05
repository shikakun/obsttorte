export type D1LocationHint = "apac" | "oc" | "weur" | "eeur" | "wnam" | "enam";

export type InstallationState = {
  version: 1;
  worker: string;
  domain: string | null;
  database: { name: string; id: string; location: D1LocationHint | null };
  bucket: { name: string };
  access: { aud: string; clientId: string; tokenExpiresAt: string } | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
};

export const WORKER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const LOCATION_HINTS = ["apac", "oc", "weur", "eeur", "wnam", "enam"] as const;
export const LOCATION_LABELS: Record<D1LocationHint, string> = {
  apac: "Asia Pacific",
  oc: "Oceania",
  weur: "Western Europe",
  eeur: "Eastern Europe",
  wnam: "Western North America",
  enam: "Eastern North America",
};
export const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function customDomainUrl(domain: string | null): string | null {
  return domain ? `https://${domain}` : null;
}

export function findWorkersDevUrl(output: string, worker: string): string | null {
  const urls = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/gi) ?? [];
  return urls.find((url) => url.startsWith(`https://${worker}.`)) ?? null;
}
