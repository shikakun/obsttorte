import { ApiRequestError, type SyncFailure } from "@obsttorte/engine";
import { t } from "./i18n";

export function failureOf(error: unknown): SyncFailure {
  if (error instanceof ApiRequestError) {
    return { kind: error.kind, status: error.status, message: error.message };
  }
  return { kind: null, status: null, message: error instanceof Error ? error.message : "" };
}

/** 失敗を、利用者が次に何をすればよいかわかる文に置き換える */
export function describeFailure(
  failure: SyncFailure | undefined,
  context: "sync" | "action" = "sync",
): string {
  const unknown = context === "sync" ? "problem.unknown" : "problem.actionUnknown";
  if (!failure) return t(unknown);
  const { kind, status, message } = failure;
  if (kind === null) {
    if (!message) return t(unknown);
    return t(context === "sync" ? "problem.failed" : "problem.actionFailed", { message });
  }
  // ApiClientはネットワークの失敗とタイムアウトをstatus 0で表す
  if (status === 0) return t("problem.network");
  if (kind === "unauthorized") return t("problem.unauthorized");
  if (kind === "forbidden") return t("problem.forbidden");
  if (kind === "version") return t("problem.version");
  if (kind === "rate-limited") return t("problem.rateLimited");
  if (kind === "maintenance") return t("problem.maintenance");
  // Accessのログインページなど、Obsttorte以外の応答はJSONとして読めない
  if (kind === "not-found" || (status !== null && status < 400)) return t("problem.notObsttorte");
  return t("problem.server", { status: status ?? 0, message });
}
