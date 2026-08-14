import { MessageSquare, Radio, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { GradientOrb, ORB_TONES } from "@/components/brand/gradient-orb";
import { OrbCard } from "@/components/brand/orb-card";
import { WaveformCard } from "@/components/brand/waveform-card";
import { VoiceRow } from "@/components/brand/voice-row";
import { PricingTier } from "@/components/brand/pricing-tier";
import {
  FeatureCard,
  ProductCardStack,
  TestimonialCard,
} from "@/components/brand/content-cards";
import { CtaBand, HeroBand, SiteFooter } from "@/components/brand/bands";
import { TopNav } from "@/components/brand/top-nav";
import { Section, SubHeading, Rule } from "./primitives";

/** Every component in the design system, in every variant it ships with. */

/* ------------------------------------------------------------------ */

export function OrbGallery() {
  return (
    <Section
      id="orbs"
      title="Atmospheric orbs"
      lede="The brand's only colour moment, and strictly decoration. An orb is blurred, absolutely positioned, aria-hidden and pointer-events:none. It never becomes a surface, a button fill or a text colour."
    >
      <SubHeading>Tones</SubHeading>
      <div className="grid grid-cols-2 gap-lg tablet:grid-cols-3 desktop:grid-cols-5">
        {ORB_TONES.map((tone) => (
          <div key={tone} className="flex flex-col gap-xs">
            <div className="relative isolate h-32 overflow-hidden rounded-lg border border-hairline bg-canvas-soft">
              <GradientOrb
                tone={tone}
                className="left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2"
              />
            </div>
            <p className="text-body-sm text-ink">{tone}</p>
          </div>
        ))}
      </div>

      <SubHeading>gradient-orb-card</SubHeading>
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-2 desktop:grid-cols-3">
        <OrbCard
          tone="mint"
          title="Atmosphere"
          description="A bloom behind centred display copy."
        />
        <OrbCard
          tone="peach"
          title="Never a surface"
          description="The orb is a sibling of the content, not the card background."
        />
        <OrbCard
          tone="sky"
          title="Pure decoration"
          description="Carries no content and intercepts no clicks."
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function ButtonGallery() {
  return (
    <Section
      id="buttons"
      title="Buttons"
      lede="One filled action colour in the whole system, used sparingly. Everything else is an outline, a ghost, or inline text."
    >
      <SubHeading>Variants</SubHeading>
      <div className="flex flex-wrap items-center gap-base">
        <Button>Primary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Text link</Button>
      </div>

      <SubHeading>On a dark band</SubHeading>
      <div className="flex flex-wrap items-center gap-base rounded-xl bg-surface-dark p-lg">
        <Button variant="on-dark">Inverted primary</Button>
        <span className="text-body-sm text-on-dark-soft">
          Used only inside a dark surface.
        </span>
      </div>

      <SubHeading>Sizes</SubHeading>
      <div className="flex flex-wrap items-center gap-base">
        <Button size="sm">Small</Button>
        <Button size="default">Default — 40px</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon button">
          <Radio className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <SubHeading>States</SubHeading>
      <div className="flex flex-wrap items-center gap-base">
        <Button>Default</Button>
        <Button className="bg-primary-active">Active / pressed</Button>
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          Disabled outline
        </Button>
      </div>

      <SubHeading>With an icon</SubHeading>
      <div className="flex flex-wrap items-center gap-base">
        <Button>
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Leading icon
        </Button>
        <Button variant="outline">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Outline with icon
        </Button>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function BadgeGallery() {
  return (
    <Section
      id="badges"
      title="Badges"
      lede="Always pill geometry, always the uppercase caption step. On the semantic variants the colour is carried by the text, not a fill — a filled colour would read as an action."
    >
      <div className="flex flex-wrap items-center gap-base">
        <Badge>Default</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="success">Success</Badge>
        <Badge variant="error">Error</Badge>
      </div>

      <div className="mt-lg flex flex-wrap items-center gap-base rounded-xl bg-surface-dark p-lg">
        <Badge variant="on-dark">On dark</Badge>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function FormGallery() {
  return (
    <Section
      id="forms"
      title="Forms"
      lede="Inputs are the one place the system does not use a pill: 8px radius, 44px tall, hairline border thickening to an ink ring on focus."
    >
      <div className="grid grid-cols-1 gap-xl desktop:grid-cols-2">
        <div className="flex flex-col gap-lg">
          <div className="flex flex-col gap-xs">
            <Label htmlFor="sg-default">Default</Label>
            <Input id="sg-default" placeholder="you@example.com" />
          </div>

          <div className="flex flex-col gap-xs">
            <Label htmlFor="sg-filled">With a value</Label>
            <Input id="sg-filled" defaultValue="ada@whatsapp-os.dev" readOnly />
          </div>

          <div className="flex flex-col gap-xs">
            <Label htmlFor="sg-invalid">Error state</Label>
            <Input
              id="sg-invalid"
              aria-invalid="true"
              aria-describedby="sg-invalid-msg"
              defaultValue="not-an-email"
              readOnly
            />
            <p id="sg-invalid-msg" className="text-caption text-error">
              Not a valid email address.
            </p>
          </div>

          <div className="flex flex-col gap-xs">
            <Label htmlFor="sg-disabled">Disabled</Label>
            <Input id="sg-disabled" placeholder="Unavailable" disabled />
          </div>
        </div>

        <div className="flex flex-col gap-lg">
          <div className="flex flex-col gap-xs">
            <Label htmlFor="sg-textarea">Textarea</Label>
            <Textarea id="sg-textarea" placeholder="Say something…" />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-base">
            <Label htmlFor="sg-switch">
              Switch
              <span className="mt-xxs block text-caption font-normal text-muted">
                Checked is ink, not green — a toggle is an action.
              </span>
            </Label>
            <Switch id="sg-switch" defaultChecked />
          </div>

          <div className="flex items-center justify-between gap-base">
            <Label htmlFor="sg-switch-off">Unchecked</Label>
            <Switch id="sg-switch-off" />
          </div>

          <div className="flex items-center justify-between gap-base">
            <Label htmlFor="sg-switch-disabled">Disabled</Label>
            <Switch id="sg-switch-disabled" disabled />
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function CardGallery() {
  return (
    <Section
      id="cards"
      title="Cards"
      lede="White surfaces on the off-white canvas, separated by a hairline. 16px radius throughout; only the orb card softens to 24px."
    >
      <SubHeading>feature-card</SubHeading>
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-2 desktop:grid-cols-3">
        <FeatureCard
          icon={MessageSquare}
          title="Hairline first"
          description="Cards separate from the canvas with a 1px hairline, not a shadow."
        />
        <FeatureCard
          icon={Radio}
          title="One shadow tier"
          description="A single soft drop on hover. There is no elevation ramp."
        />
        <FeatureCard
          icon={ShieldCheck}
          title="Titles run Inter"
          description="Component titles use the body face at 500, not the display serif."
        />
      </div>

      <SubHeading>testimonial-card</SubHeading>
      <div className="grid grid-cols-1 gap-lg desktop:grid-cols-2">
        <TestimonialCard
          quote="Emphasis comes from value contrast, never from a louder colour."
          author="Design system"
          role="Colour principle"
        />
        <TestimonialCard
          quote="The display weight stays light. Bolding it changes the brand's voice."
          author="Design system"
          role="Type principle"
        />
      </div>

      <SubHeading>product-card-stack</SubHeading>
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-2 desktop:grid-cols-3">
        <ProductCardStack
          label="Padding 0"
          title="Edge to edge"
          rows={["Children reach the card edge", "Hairlines span the full width", "Header sits on the strong surface"]}
        />
        <ProductCardStack
          label="Structure"
          title="Stacked rows"
          rows={["Row one", "Row two", "Row three"]}
        />
        <ProductCardStack
          label="Usage"
          title="Previews"
          rows={["Product summaries", "Grouped settings", "Compact lists"]}
        />
      </div>

      <SubHeading>Dark inversion</SubHeading>
      <Card variant="dark" padding="lg">
        <p className="text-caption-uppercase uppercase text-on-dark-soft">
          surface-dark
        </p>
        <p className="mt-xs font-display text-display-sm text-on-dark">
          The same card, inverted
        </p>
        <p className="mt-xs text-body-sm text-on-dark-soft">
          Used for the featured pricing tier and the rare dark hero.
        </p>
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function VoiceGallery() {
  return (
    <Section
      id="voice"
      title="Voice library"
      lede="Transparent rows on hairline dividers, with a 32px circular icon. The 12px vertical padding gives a ~48px tap target around a smaller glyph."
    >
      <div className="grid grid-cols-1 gap-xl desktop:grid-cols-2">
        <div>
          <SubHeading>voice-row</SubHeading>
          <Card padding="md">
            <VoiceRow name="Aria" accent="American · Narration" initials="AR" />
            <VoiceRow name="Bram" accent="British · Conversational" initials="BR" />
            <VoiceRow name="Céline" accent="French · Warm" initials="CE" />
            <VoiceRow name="Dae" accent="Korean · Neutral" initials="DA" />
          </Card>
        </div>

        <div>
          <SubHeading>voice-icon-circular</SubHeading>
          <div className="flex items-center gap-base rounded-xl border border-hairline bg-surface-card p-lg">
            {["AR", "BR", "CE", "DA", "EL"].map((initials) => (
              <Avatar key={initials}>
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            ))}
          </div>

          <SubHeading>audio-waveform-card</SubHeading>
          <WaveformCard
            name="Aria — product tour"
            meta="American · Narration"
            duration="0:42"
          />
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function PricingGallery() {
  return (
    <Section
      id="pricing"
      title="Pricing"
      lede="The featured tier is distinguished by inverting to the dark surface, not by introducing a colour."
    >
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-2 desktop:grid-cols-3">
        <PricingTier
          name="Starter"
          price="$0"
          cadence="/month"
          description="For evaluating the platform."
          features={["1 workspace", "10k messages", "Community support"]}
        />
        <PricingTier
          featured
          name="Team"
          price="$49"
          cadence="/month"
          description="For teams running production workloads."
          features={["Unlimited workspaces", "1M messages", "Priority support", "Audit log"]}
        />
        <PricingTier
          name="Enterprise"
          price="Custom"
          cadence=""
          description="For regulated and high-volume deployments."
          features={["SSO and SCIM", "Custom retention", "Dedicated support"]}
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function BandGallery() {
  return (
    <Section
      id="bands"
      title="Bands"
      lede="Full-width sections on the canvas at a 96px rhythm. Shown here inside a bordered frame so the band edges are visible."
    >
      <SubHeading>top-nav</SubHeading>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <div className="relative">
          <TopNav className="!static" />
        </div>
      </div>

      <SubHeading>hero-band</SubHeading>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <HeroBand
          eyebrow="Design system"
          title="Voice is an interface"
          subtitle="An editorial canvas, modest type weights, and atmospheric colour that never asks to be clicked."
        />
      </div>

      <SubHeading>cta-band</SubHeading>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <CtaBand title="Everything you need to start building" />
      </div>

      <SubHeading>footer</SubHeading>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <SiteFooter />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function RulesGallery() {
  return (
    <Section
      id="rules"
      title="Do's and don'ts"
      lede="The constraints that keep this system recognisable."
    >
      <div className="grid grid-cols-1 gap-xl desktop:grid-cols-2">
        <div>
          <SubHeading>Do</SubHeading>
          <ul className="flex flex-col gap-sm">
            <Rule tone="do">
              reserve the ink pill for the single primary action in a view.
            </Rule>
            <Rule tone="do">
              keep display copy at the light weight — it is the editorial
              signature.
            </Rule>
            <Rule tone="do">
              run body Inter at 400/500 with roughly +0.15px tracking.
            </Rule>
            <Rule tone="do">
              use gradient orbs as atmosphere behind content.
            </Rule>
            <Rule tone="do">
              use pill geometry for every CTA and badge.
            </Rule>
          </ul>
        </div>

        <div>
          <SubHeading>Don&apos;t</SubHeading>
          <ul className="flex flex-col gap-sm">
            <Rule tone="dont">
              introduce a saturated brand action colour. The ink pill is the
              only CTA fill.
            </Rule>
            <Rule tone="dont">
              bold display copy — it shifts the voice from editorial to consumer
              marketing.
            </Rule>
            <Rule tone="dont">
              use a gradient orb as a button fill, a text colour or a component
              background.
            </Rule>
            <Rule tone="dont">
              put sharp 0px corners on a CTA.
            </Rule>
            <Rule tone="dont">
              drop body Inter to 300 to match the display face — legibility
              comes first.
            </Rule>
          </ul>
        </div>
      </div>
    </Section>
  );
}
