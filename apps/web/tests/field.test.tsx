import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";

/**
 * These assert the accessibility wiring, which is the entire reason Field
 * exists as a component rather than a copied-and-pasted pattern. Every one of
 * these is invisible in a screenshot and painful to discover later.
 */

describe("Field", () => {
  it("associates the label with the control", () => {
    render(<Field label="Work email" name="email" />);

    /* getByLabelText only finds it if htmlFor and id actually match. */
    const input = screen.getByLabelText("Work email");
    expect(input).toBeDefined();
    expect(input.getAttribute("name")).toBe("email");
  });

  it("links the error message via aria-describedby", () => {
    render(
      <Field label="Work email" name="email" error="Enter a valid email address." />,
    );

    const input = screen.getByLabelText("Work email");
    const describedBy = input.getAttribute("aria-describedby");

    expect(describedBy).toBeTruthy();

    const message = document.getElementById(describedBy!);
    expect(message?.textContent).toBe("Enter a valid email address.");
  });

  it("marks the control invalid only when there is an error", () => {
    const { rerender } = render(<Field label="Email" name="email" />);
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBeNull();

    rerender(<Field label="Email" name="email" error="Nope." />);
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("references both the description and the error at once", () => {
    /* The hint must not vanish exactly when the field goes invalid. */
    render(
      <Field
        label="Username"
        name="username"
        description="3–32 characters."
        error="That username is taken."
      />,
    );

    const ids = screen
      .getByLabelText("Username")
      .getAttribute("aria-describedby")!
      .split(" ");

    expect(ids).toHaveLength(2);
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("3–32 characters.");
    expect(texts).toContain("That username is taken.");
  });

  it("hides the required marker from assistive tech", () => {
    const { container } = render(
      <Field label="Full name" name="fullName" required />,
    );

    /*
     * The asterisk is decoration. The real signal is the required attribute,
     * which is announced as "required"; an asterisk read aloud as "star" is
     * noise that communicates nothing.
     */
    const marker = container.querySelector("[aria-hidden='true']");
    expect(marker?.textContent?.trim()).toBe("*");

    expect(screen.getByLabelText(/Full name/).hasAttribute("required")).toBe(true);
  });

  it("passes control attributes through", () => {
    /*
     * autoComplete in particular: without it password managers misbehave and
     * users blame the product rather than the markup.
     */
    render(
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
      />,
    );

    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
  });

  it("does not cap the password length in the markup", () => {
    /*
     * maxLength on a password input silently truncates a pasted passphrase,
     * and the user then cannot sign in with what they think they set. The 256
     * cap belongs in the Zod schema only.
     */
    render(<Field label="Password" name="password" type="password" />);
    expect(screen.getByLabelText("Password").hasAttribute("maxlength")).toBe(
      false,
    );
  });
});

describe("FormStatus", () => {
  it("mounts the live region even with no message", () => {
    /*
     * aria-live only announces changes to a region already in the
     * accessibility tree. Mounting element and text together is the common bug
     * that makes the announcement silently do nothing.
     */
    render(<FormStatus />);

    const region = screen.getByRole("status");
    expect(region).toBeDefined();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("announces the message through the same region", () => {
    const { rerender } = render(<FormStatus />);
    const before = screen.getByRole("status");

    rerender(<FormStatus message="That username and password do not match." />);
    const after = screen.getByRole("status");

    /* Same node, new content — which is what a live region announces. */
    expect(after).toBe(before);
    expect(after.textContent).toBe(
      "That username and password do not match.",
    );
  });

  it("renders exactly one message", () => {
    render(<FormStatus message="Something went wrong." />);
    expect(screen.getByRole("status").querySelectorAll("p")).toHaveLength(1);
  });
});
