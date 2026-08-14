import type { Metadata } from "next";
import { readTokenGroups } from "@/lib/tokens";
import { TopNav } from "@/components/brand/top-nav";
import { SiteFooter } from "@/components/brand/bands";
import { GradientOrb } from "@/components/brand/gradient-orb";
import { Section, TokenName } from "./_components/primitives";
import { FieldGallery, ShellGallery } from "./_components/app-gallery";
import {
  ColourGallery,
  ElevationGallery,
  RadiusGallery,
  SpacingGallery,
  TypographyGallery,
} from "./_components/token-galleries";
import {
  BadgeGallery,
  BandGallery,
  ButtonGallery,
  CardGallery,
  FormGallery,
  OrbGallery,
  PricingGallery,
  RulesGallery,
  VoiceGallery,
} from "./_components/component-gallery";

export const metadata: Metadata = {
  title: "Styleguide",
  description:
    "Every design token and component variant in the whatsapp-os design system.",
};

/**
 * The styleguide.
 *
 * Tokens are parsed from app/globals.css at build time rather than restated
 * here, so this page documents what the system actually is rather than what it
 * was when someone last updated the docs.
 */
export default async function StyleguidePage() {
  const groups = await readTokenGroups();
  const tokenCount = groups.reduce((sum, g) => sum + g.tokens.length, 0);

  return (
    <>
      <TopNav />

      <main className="mx-auto max-w-container px-lg">
        {/* ---------------------------------------------------------- */}
        <section
          id="overview"
          className="relative isolate overflow-hidden py-section"
        >
          <GradientOrb
            tone="mint"
            className="-left-20 top-0 h-[340px] w-[340px]"
          />
          <GradientOrb
            tone="rose"
            className="-right-16 top-24 h-[280px] w-[280px]"
          />

          <div className="wa-above-orbs">
            <p className="text-caption-uppercase uppercase text-muted">
              whatsapp-os design system
            </p>
            <h1 className="mt-base max-w-3xl text-display-xl text-ink desktop:text-display-mega">
              Styleguide
            </h1>
            <p className="mt-lg max-w-2xl text-body-md text-body">
              An editorial canvas holding warm near-black ink. The brand
              voltage is photographic rather than chromatic: soft pastel orbs
              drift through the page as the only colour moment. There is no
              saturated accent, no coloured CTA, and display copy never bolds.
            </p>

            <dl className="mt-xl flex flex-wrap gap-xl">
              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Tokens
                </dt>
                <dd className="mt-xxs font-display text-display-sm text-ink">
                  {tokenCount}
                </dd>
              </div>
              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Groups
                </dt>
                <dd className="mt-xxs font-display text-display-sm text-ink">
                  {groups.length}
                </dd>
              </div>
              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Source
                </dt>
                <dd className="mt-xxs font-display text-display-sm text-ink">
                  globals.css
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        <ColourGallery groups={groups} />
        <TypographyGallery groups={groups} />
        <RadiusGallery groups={groups} />
        <SpacingGallery groups={groups} />
        <ElevationGallery />

        {/* ---------------------------------------------------------- */}
        <OrbGallery />
        <ButtonGallery />
        <BadgeGallery />
        <FormGallery />
        <FieldGallery />
        <ShellGallery />
        <CardGallery />
        <VoiceGallery />
        <PricingGallery />
        <BandGallery />
        <RulesGallery />

        {/* ---------------------------------------------------------- */}
        <Section
          id="reference"
          title="Full token reference"
          lede={`All ${tokenCount} custom properties, exactly as declared in app/globals.css.`}
        >
          <div className="flex flex-col gap-xl">
            {groups.map((group) => (
              <div key={group.index}>
                <h3 className="mb-sm font-body text-title-sm text-ink">
                  {group.index}. {group.title}
                </h3>

                <div className="overflow-x-auto rounded-lg border border-hairline">
                  <table className="w-full min-w-[560px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-hairline bg-surface-strong">
                        <th className="px-base py-sm text-caption-uppercase uppercase text-muted">
                          Token
                        </th>
                        <th className="px-base py-sm text-caption-uppercase uppercase text-muted">
                          Value
                        </th>
                        <th className="px-base py-sm text-caption-uppercase uppercase text-muted">
                          Note
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.tokens.map((token) => (
                        <tr
                          key={token.name}
                          className="border-b border-hairline-soft last:border-b-0"
                        >
                          <td className="px-base py-sm align-top">
                            <TokenName>{token.name}</TokenName>
                          </td>
                          <td className="px-base py-sm align-top">
                            <span className="flex items-center gap-xs">
                              {token.value.startsWith("#") ? (
                                <span
                                  aria-hidden="true"
                                  className="h-4 w-4 shrink-0 rounded-xs border border-hairline"
                                  style={{
                                    backgroundColor: `var(${token.name})`,
                                  }}
                                />
                              ) : null}
                              <TokenName>{token.value}</TokenName>
                            </span>
                          </td>
                          <td className="px-base py-sm align-top text-caption text-muted">
                            {token.note ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
