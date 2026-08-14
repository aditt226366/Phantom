import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "./password.ts";
import { emailSchema, shortTextSchema } from "./schemas.ts";

/**
 * Validation for the sign-up and sign-in forms.
 *
 * Only shape and format live here. Anything needing a database or the network —
 * username availability, the breach check, phone parsing — happens in the
 * action, because a Zod schema that awaits an HTTP call is a Zod schema that
 * silently makes every validation pass slow.
 */

/**
 * Lowercased before the pattern is applied.
 *
 * Order matters. Normalising first means "Alice" becomes "alice" and is
 * accepted; validating first would reject it as containing invalid characters.
 * Since the stored value is always lowercase, an ordinary unique index gives
 * case-insensitive uniqueness with no citext extension.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .regex(
        /^[a-z0-9_.]{3,32}$/,
        "Username must be 3-32 characters, using letters, numbers, dots or underscores",
      ),
  );

/**
 * Length only.
 *
 * The interesting checks — the bundled denylist and the HaveIBeenPwned range
 * lookup — are deliberately not here: one reads a file, the other makes a
 * network call, and neither belongs inside a synchronous parse.
 *
 * The maximum matches what hashPassword will actually consume. Accepting more
 * than that would silently truncate, so a user could set a 300-character
 * password and sign in with the first 256.
 */
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(
    MAX_PASSWORD_LENGTH,
    `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
  );

/**
 * Free text as typed. Parsed to E.164 by parsePhone() in the action, which
 * needs libphonenumber and would drag it into any bundle importing this module.
 */
export const phoneInputSchema = z
  .string()
  .trim()
  .min(1, "Contact number is required")
  .max(32);

export const signUpSchema = z
  .object({
    fullName: shortTextSchema,
    companyName: shortTextSchema,
    email: emailSchema,
    phone: phoneInputSchema,
    username: usernameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    /* Reported against the field the user must actually retype. */
    path: ["confirmPassword"],
  });

export const signInSchema = z.object({
  /*
   * Not usernameSchema. Sign-in must not tell the user their input is
   * malformed — "that is not a valid username" distinguishes a badly-formed
   * guess from a well-formed one that does not exist, which is the account
   * enumeration this whole flow is built to avoid. Lowercase and compare;
   * anything that does not match simply fails like a wrong password.
   */
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
