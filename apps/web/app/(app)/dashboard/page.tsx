import { requireSession } from "@/lib/auth/session";

/** Placeholder. The application shell and the real sections land in C8. */
export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <main className="mx-auto max-w-container px-lg py-xxl">
      <h1 className="text-display-md text-ink">Dashboard</h1>
      <p className="mt-sm text-body-md text-body">
        Signed in as {session.user.fullName}.
      </p>
    </main>
  );
}
