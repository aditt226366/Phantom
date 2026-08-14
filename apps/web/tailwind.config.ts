import type { Config } from "tailwindcss";

/**
 * whatsapp-os Tailwind theme.
 *
 * Translated from DESIGN-elevenlabs.md.
 *
 * There is deliberately not a single literal colour, size or radius in this
 * file. Every entry points at a CSS custom property declared in
 * app/globals.css, which is the single source of truth for raw values.
 * Changing a brand value means editing exactly one line, in one file.
 */

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Surface */
        canvas: {
          DEFAULT: "var(--wa-canvas)",
          soft: "var(--wa-canvas-soft)",
          deep: "var(--wa-canvas-deep)",
        },
        surface: {
          card: "var(--wa-surface-card)",
          strong: "var(--wa-surface-strong)",
          dark: "var(--wa-surface-dark)",
          "dark-elevated": "var(--wa-surface-dark-elevated)",
        },

        /* Ink & action - the only CTA colour in the system */
        ink: "var(--wa-ink)",
        primary: {
          DEFAULT: "var(--wa-primary)",
          active: "var(--wa-primary-active)",
        },

        /* Text */
        body: {
          DEFAULT: "var(--wa-body)",
          strong: "var(--wa-body-strong)",
        },
        muted: {
          DEFAULT: "var(--wa-muted)",
          soft: "var(--wa-muted-soft)",
        },
        on: {
          primary: "var(--wa-on-primary)",
          dark: "var(--wa-on-dark)",
          "dark-soft": "var(--wa-on-dark-soft)",
        },

        /* Hairlines */
        hairline: {
          DEFAULT: "var(--wa-hairline)",
          soft: "var(--wa-hairline-soft)",
          strong: "var(--wa-hairline-strong)",
        },

        /* Atmospheric gradient stops - decoration only.
           Exposed so the orb component can reference them; never apply these
           as bg-* on a surface or a button. */
        gradient: {
          mint: "var(--wa-gradient-mint)",
          peach: "var(--wa-gradient-peach)",
          lavender: "var(--wa-gradient-lavender)",
          sky: "var(--wa-gradient-sky)",
          rose: "var(--wa-gradient-rose)",
        },

        /* Semantic - green lives here and nowhere else */
        success: "var(--wa-success)",
        error: "var(--wa-error)",
      },

      fontFamily: {
        display: "var(--wa-font-display)",
        body: "var(--wa-font-body)",
      },

      fontWeight: {
        display: "var(--wa-display-weight)",
        regular: "var(--wa-weight-regular)",
        medium: "var(--wa-weight-medium)",
        semibold: "var(--wa-weight-semibold)",
      },

      /**
       * Type steps. Each utility carries size + line-height + tracking +
       * weight, so `text-display-lg` reproduces one full row of the design
       * doc's type table.
       */
      fontSize: {
        "display-mega": [
          "var(--wa-text-display-mega)",
          {
            lineHeight: "var(--wa-leading-display-mega)",
            letterSpacing: "var(--wa-tracking-display-mega)",
            fontWeight: "var(--wa-display-weight)",
          },
        ],
        "display-xl": [
          "var(--wa-text-display-xl)",
          {
            lineHeight: "var(--wa-leading-display-xl)",
            letterSpacing: "var(--wa-tracking-display-xl)",
            fontWeight: "var(--wa-display-weight)",
          },
        ],
        "display-lg": [
          "var(--wa-text-display-lg)",
          {
            lineHeight: "var(--wa-leading-display-lg)",
            letterSpacing: "var(--wa-tracking-display-lg)",
            fontWeight: "var(--wa-display-weight)",
          },
        ],
        "display-md": [
          "var(--wa-text-display-md)",
          {
            lineHeight: "var(--wa-leading-display-md)",
            letterSpacing: "var(--wa-tracking-display-md)",
            fontWeight: "var(--wa-display-weight)",
          },
        ],
        "display-sm": [
          "var(--wa-text-display-sm)",
          {
            lineHeight: "var(--wa-leading-display-sm)",
            letterSpacing: "var(--wa-tracking-display-sm)",
            fontWeight: "var(--wa-display-weight)",
          },
        ],
        "title-md": [
          "var(--wa-text-title-md)",
          {
            lineHeight: "var(--wa-leading-title-md)",
            letterSpacing: "var(--wa-tracking-title-md)",
            fontWeight: "var(--wa-weight-medium)",
          },
        ],
        "title-sm": [
          "var(--wa-text-title-sm)",
          {
            lineHeight: "var(--wa-leading-title-sm)",
            letterSpacing: "var(--wa-tracking-title-sm)",
            fontWeight: "var(--wa-weight-medium)",
          },
        ],
        "body-md": [
          "var(--wa-text-body-md)",
          {
            lineHeight: "var(--wa-leading-body-md)",
            letterSpacing: "var(--wa-tracking-body-md)",
            fontWeight: "var(--wa-weight-regular)",
          },
        ],
        "body-strong": [
          "var(--wa-text-body-strong)",
          {
            lineHeight: "var(--wa-leading-body-strong)",
            letterSpacing: "var(--wa-tracking-body-strong)",
            fontWeight: "var(--wa-weight-medium)",
          },
        ],
        "body-sm": [
          "var(--wa-text-body-sm)",
          {
            lineHeight: "var(--wa-leading-body-sm)",
            letterSpacing: "var(--wa-tracking-body-sm)",
            fontWeight: "var(--wa-weight-regular)",
          },
        ],
        caption: [
          "var(--wa-text-caption)",
          {
            lineHeight: "var(--wa-leading-caption)",
            letterSpacing: "var(--wa-tracking-caption)",
            fontWeight: "var(--wa-weight-regular)",
          },
        ],
        "caption-uppercase": [
          "var(--wa-text-caption-uppercase)",
          {
            lineHeight: "var(--wa-leading-caption-uppercase)",
            letterSpacing: "var(--wa-tracking-caption-uppercase)",
            fontWeight: "var(--wa-weight-semibold)",
          },
        ],
        button: [
          "var(--wa-text-button)",
          {
            lineHeight: "var(--wa-leading-button)",
            letterSpacing: "var(--wa-tracking-button)",
            fontWeight: "var(--wa-weight-medium)",
          },
        ],
        "nav-link": [
          "var(--wa-text-nav-link)",
          {
            lineHeight: "var(--wa-leading-nav-link)",
            letterSpacing: "var(--wa-tracking-nav-link)",
            fontWeight: "var(--wa-weight-medium)",
          },
        ],
      },

      letterSpacing: {
        base: "var(--wa-tracking-base)",
      },

      borderRadius: {
        none: "var(--wa-radius-none)",
        xs: "var(--wa-radius-xs)",
        sm: "var(--wa-radius-sm)",
        md: "var(--wa-radius-md)",
        lg: "var(--wa-radius-lg)",
        xl: "var(--wa-radius-xl)",
        xxl: "var(--wa-radius-xxl)",
        pill: "var(--wa-radius-pill)",
        full: "var(--wa-radius-full)",
      },

      spacing: {
        xxs: "var(--wa-space-xxs)",
        xs: "var(--wa-space-xs)",
        sm: "var(--wa-space-sm)",
        base: "var(--wa-space-base)",
        md: "var(--wa-space-md)",
        lg: "var(--wa-space-lg)",
        xl: "var(--wa-space-xl)",
        xxl: "var(--wa-space-xxl)",
        section: "var(--wa-space-section)",
      },

      boxShadow: {
        "soft-drop": "var(--wa-shadow-soft-drop)",
      },

      height: {
        nav: "var(--wa-nav-height)",
        button: "var(--wa-button-height)",
        input: "var(--wa-input-height)",
        "voice-icon": "var(--wa-voice-icon-size)",
      },

      width: {
        "voice-icon": "var(--wa-voice-icon-size)",
      },

      maxWidth: {
        container: "var(--wa-container-max)",
      },

      /* Matches the design doc's responsive table:
         mobile < 640 - tablet 640-1024 - desktop 1024-1280 - wide > 1280 */
      screens: {
        tablet: "640px",
        desktop: "1024px",
        wide: "1280px",
      },
    },
  },
  plugins: [],
};

export default config;
