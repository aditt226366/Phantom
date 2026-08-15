import { requireAdminSession } from "@/lib/auth/admin-session";
import { AdminNav } from "../_components/admin-nav";

/**
 * Chrome for the console.
 *
 * The requireAdminSession() call here is UX, not authorization — CLAUDE.md
 * rule 4. A layout is cached per segment and is not guaranteed to re-execute
 * on every navigation within it, so this redirects a signed-out operator
 * promptly and nothing more. Every page and every action underneath calls it
 * again for itself, and React cache() makes the repeat free.
 *
 * The (console) route group is what keeps /admin/sign-in out of this layout.
 * A layout at admin/ would wrap the sign-in page too, and since
 * requireAdminSession() redirects *to* that page, rendering it would call this
 * guard again — a redirect loop that locks every operator out of the panel and
 * looks like a broken deployment. Route groups do not appear in the URL, so
 * /admin and /admin/companies are unaffected.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdminSession();

  return (
    <div className="min-h-dvh bg-canvas">
      <AdminNav username={session.username} />
      <main className="mx-auto max-w-container px-lg py-xl">{children}</main>
    </div>
  );
}
