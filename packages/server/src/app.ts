import { apiError } from "@obsttorte/shared/errors";
import { apiVersionRange } from "@obsttorte/shared/version";
import { Hono } from "hono";
import { requireAccess, requireApiVersion, requireDevice } from "./auth";
import type { AppEnv } from "./env";
import { registerContentRoutes } from "./routes";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("rowsRead", 0);
  c.set("rowsWritten", 0);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Obsttorte-Api-Range", apiVersionRange());
  const started = Date.now();
  await next();
  console.log(
    JSON.stringify({
      method: c.req.method,
      status: c.res.status,
      durationMs: Date.now() - started,
      rowsRead: c.get("rowsRead") ?? 0,
      rowsWritten: c.get("rowsWritten") ?? 0,
    }),
  );
});

app.use("*", requireAccess);
app.use("/api/*", requireDevice);
app.use("/api/*", requireApiVersion);
registerContentRoutes(app);

app.notFound((c) => c.json(apiError("invalid_request", "Not found"), 404));
app.onError((error, c) => {
  console.log(JSON.stringify({ message: "internal", name: error.name }));
  return c.json(apiError("internal", "Internal error"), 500);
});
