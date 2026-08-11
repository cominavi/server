---
name: ComiNavi
description: Focused action surfaces that carry planning intent from discovery to the venue.
---

# Design System: ComiNavi

## Overview

**Creative North Star: "The Focused Action Relay"**

ComiNavi's public web surfaces extend the native iOS focused-action language.
Each important moment has one orientation cue, one clear hierarchy, and one
obvious next action. Large ambient Lucide symbols make the page feel alive and
spatial without becoming illustrative chrome.

The system is calm rather than quiet to the point of anonymity. Scale, overlap,
and the green accent provide energy; neutral fields and disciplined secondary
copy keep the experience legible under the same attention constraints as the
app.

**Key Characteristics:**

- Strong left alignment and generous breathing room.
- One oversized low-opacity symbol as the recurring orientation cue.
- ComiNavi green used deliberately for action and identity.
- Rounded system typography with natural Japanese rhythm.
- A clear primary action rather than clusters of equal-weight links.

## Colors

ComiNavi green (`#A3D21B`) is the sole primary accent. Near-black text sits on
white and cool neutral surfaces; secondary text stays visibly subordinate, and
hairline separators organize dense content without framing every region.

**The One Accent Rule.** Green identifies ComiNavi and actionable state. Do not
introduce a second decorative hue to manufacture variety.

| Token        | Value     | Use                                     |
| ------------ | --------- | --------------------------------------- |
| Accent       | `#A3D21B` | Primary actions, route, active identity |
| Accent ink   | `#253200` | Text and icons on the accent            |
| Ink          | `#161815` | Headings and primary text               |
| Muted        | `#62685F` | Supporting copy and metadata            |
| Hairline     | `#DFE4DA` | Open-section dividers                   |
| Soft surface | `#F3F6EF` | Route and collaboration fields          |
| Error        | `#DC4C59` | Unavailable invitation status only      |

## Typography

Japanese display and interface copy use a rounded system stack led by Hiragino
Maru Gothic and Zen Maru Gothic, with Apple system and Japanese sans fallbacks.
Headlines are compact, bold, and phrase-balanced. Prose uses ordinary Japanese
wrapping and comfortable line height; metadata remains small but never faint.

**The Spoken Phrase Rule.** Authored display copy may break only at natural
semantic phrases. Dynamic plan names and prose retain native line wrapping.

## Layout

The layout behaves like a sequence of focused app states rather than a printed
document. Wide screens use offset content and deliberate negative space;
narrow screens collapse to one readable column without shrinking the primary
action below a comfortable touch target. Full-viewport moments alternate with
denser capability passages to pace the scroll.

The homepage hero is a two-column continuous route at wide widths and a single
vertical sequence on mobile. Its three stops are always discovery, shared
planning, and venue navigation. Feature content stays in open,
hairline-separated rows; it must not collapse into a generic card grid.

## Elevation & Depth

The system is flat by default. Depth comes from tonal surface changes, scale,
overlap, and ambient icon fields. Shadows are soft and sparse, reserved for a
control that genuinely lifts from its field rather than for generic containers.

**The Ambient Depth Rule.** An oversized symbol may sit behind content at very
low opacity, but it can never reduce text contrast or become a watermark logo.

## Shapes

Primary actions and compact status labels use full capsules. Functional
surfaces use generous continuous corners when they need containment, while
content sections generally stay open and rely on spacing rather than boxes.

## Components

- **Wordmark:** compass symbol plus uppercase COMINAVI, with compact utility
  navigation.
- **Route thread:** solid green SVG path with circular stops and one open state
  at each stop. Never render it with a gradient or decorative glow.
- **Primary action:** green capsule, directional icon, comfortable touch height,
  and a visible focus ring.
- **Feature row:** sequence number, line icon, display phrase, prose, and compact
  factual tags separated by hairlines.
- **Invitation context:** inviter avatar and display name first, followed by the
  Comiket and explicit Japan-time expiration.
- **Invitation action state:** valid and unavailable invitations use the same
  full-page composition. The unavailable state swaps in the iOS-like red status
  strip and ambient warning symbol without becoming a generic error card.

## Responsive and motion

At narrow widths the homepage route follows the hero copy and begins inside the
first viewport. Authored Japanese display phrases receive explicit semantic
breaks where native wrapping would clip; dynamic plan names retain natural
wrapping. The invitation's primary app action remains visible in the mobile
first viewport after its trust context.

Ambient symbols may drift slowly when motion is allowed. Content, controls, and
route meaning never depend on animation, and reduced-motion preferences disable
the drift.

## Do's and Don'ts

### Do:

- **Do** make the primary action identifiable within a few seconds.
- **Do** use Lucide symbols consistently with the iOS app.
- **Do** let green own meaningful state and leave most of the surface neutral.
- **Do** preserve visible focus, reduced motion, contrast, and responsive CJK
  typography.

### Don't:

- **Don't** use gradients, decorative glassmorphism, or glow effects.
- **Don't** use cream paper, editorial grids, heavy black outlines, offset print
  shadows, or stacked generic cards.
- **Don't** center every section or turn feature copy into an undifferentiated
  marketing list.
- **Don't** animate content into visibility; motion is ambient and optional.
