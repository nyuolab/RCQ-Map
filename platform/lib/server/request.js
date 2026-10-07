import crypto from "node:crypto";

export function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function checkAccessCode(request, payload) {
  const required = process.env.EVAL_ACCESS_CODE;
  if (!required) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, status: 503, error: "EVAL_ACCESS_CODE is not configured." };
    }
    return { ok: true };
  }

  const supplied = request.headers.get("x-access-code") || payload?.accessCode || "";
  if (!safeEqual(supplied, required)) {
    return { ok: false, status: 401, error: "Invalid access code." };
  }
  return { ok: true };
}

export function publicError(error, fallback) {
  console.error(error);
  const message = error?.message || fallback;
  const databaseMissing = message.includes("Database not configured");
  return json(databaseMissing ? 503 : 500, {
    error: databaseMissing ? message : fallback,
  });
}
