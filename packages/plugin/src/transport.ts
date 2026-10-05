import { ApiClient, type HttpResult, type Transport } from "@obsttorte/engine";
import { type RequestUrlParam, requestUrl } from "obsidian";

export function createTransport(timeoutMs: number): Transport {
  return async (input) => {
    const sent = requestUrl({
      url: input.path,
      method: input.method,
      headers: input.headers,
      body: input.body,
      throw: false,
    } satisfies RequestUrlParam);
    const response = await Promise.race([
      sent,
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) headers.set(key, value);
    const result: HttpResult = { status: response.status, headers, body: response.arrayBuffer };
    return result;
  };
}

export function createApiClient(baseUrl: string, headers: Record<string, string>): ApiClient {
  const transport = createTransport(60_000);
  return new ApiClient({
    headers,
    transport: async (input) =>
      transport({ ...input, path: new URL(input.path, baseUrl).toString() }),
  });
}
