"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROFILE_LINKS } from "@/lib/nav";

/**
 * The profile dropdown.
 *
 * Log out is a form POST, not a menu link. A GET logout is prefetchable, and
 * Next prefetches links in the viewport — so a link would sign people out when
 * a crawler, a link preview, or a hover happened to reach it. It also has a
 * side effect, which is reason enough on its own.
 */
export interface ProfileMenuProps {
  fullName: string;
  email: string;
  /** Server action. Revokes the session row and clears the cookies. */
  signOutAction: (formData: FormData) => void | Promise<void>;
  /** Hidden CSRF input, rendered by a Server Component parent. */
  csrf: React.ReactNode;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileMenu({
  fullName,
  email,
  signOutAction,
  csrf,
}: ProfileMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-xs">
          <Avatar>
            <AvatarFallback>{initials(fullName)}</AvatarFallback>
          </Avatar>
          <span className="hidden tablet:inline">{fullName}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {PROFILE_LINKS.map((link) => (
          <DropdownMenuItem key={link.href} asChild>
            <Link href={link.href}>{link.label}</Link>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <form action={signOutAction}>
            {csrf}
            <button
              type="submit"
              className="w-full cursor-pointer text-left font-body text-body-sm text-ink"
            >
              Log out
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
