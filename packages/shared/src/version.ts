export const API_VERSION = 1;
export const MIN_SUPPORTED_API_VERSION = 1;

export function isSupportedApiVersion(version: number): boolean {
  return (
    Number.isInteger(version) && version >= MIN_SUPPORTED_API_VERSION && version <= API_VERSION
  );
}

export function apiVersionRange(): string {
  return `${MIN_SUPPORTED_API_VERSION}-${API_VERSION}`;
}
