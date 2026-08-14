import { CSRF_FIELD_NAME } from "@/lib/auth/cookies";
import { readAdminCsrfToken } from "@/lib/auth/admin-session";

/** The admin CSRF hidden input. Reads the admin cookie, not the tenant one. */
export async function AdminCsrfField() {
  return (
    <input
      type="hidden"
      name={CSRF_FIELD_NAME}
      defaultValue={await readAdminCsrfToken()}
    />
  );
}
