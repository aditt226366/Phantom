import { NextResponse, type NextRequest } from "next/server";
import { consumeVerificationToken } from "@/lib/auth/verify-email";

/**
 * GET /api/auth/verify?token=…
 *
 * The token is the whole authorisation — no session is required, because the
 * link is usually opened in whatever browser the mail client hands it to.
 *
 * A token that is expired, already used, or belongs to another company all
 * produce the same 404. Not 403: per rule 3 in CLAUDE.md, and because a 403
 * confirms the token exists and is merely not yours, which is exactly the fact
 * worth withholding from someone guessing at them.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await consumeVerificationToken(token);

  if (!result.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  /*
   * Redirect rather than render, so the token leaves the address bar. A URL
   * with a live credential in it ends up in history, in a screenshot, and in
   * the Referer header of the next request.
   */
  return NextResponse.redirect(new URL("/dashboard?verified=1", request.url));
}
