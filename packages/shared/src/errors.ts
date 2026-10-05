export const ERROR_CODES = [
  "invalid_request",
  "invalid_path",
  "unauthorized",
  "access_required",
  "conflict",
  "length_required",
  "payload_too_large",
  "checksum_mismatch",
  "api_version_unsupported",
  "rate_limited",
  "maintenance",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export function apiError(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    typeof code === "string" &&
    (ERROR_CODES as readonly string[]).includes(code) &&
    typeof message === "string"
  );
}
