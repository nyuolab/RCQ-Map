import { NextResponse } from "next/server";

function unavailable() {
  return new NextResponse("Admin access is not configured", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function unauthorized() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Clinical Query Taxonomy Admin"',
    },
  });
}

export function proxy(request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return process.env.NODE_ENV === "production" ? unavailable() : NextResponse.next();

  const username = process.env.ADMIN_USER || "admin";
  const auth = request.headers.get("authorization") || "";
  const [type, encoded] = auth.split(" ");

  if (type === "Basic" && encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const u = idx >= 0 ? decoded.slice(0, idx) : "";
      const p = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (u === username && p === password) return NextResponse.next();
    } catch {
      // fall through
    }
  }

  return unauthorized();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
