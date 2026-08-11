---
version: 1
slug: "src-pages-index-astro"
primary_target: "src/pages/index.astro"
related_targets: ["src/pages/join/[token].astro"]
---

# Homepage and invitation route

## Scope and mode

- Routes: `/` and `/join/<token>`
- Mode: Persuade for the homepage; focused action for invitation completion.

## Audience, job, and action

Comiket attendees should understand that ComiNavi connects preparation to
event-day movement, then inspect the factual capabilities. Invitation
recipients should understand the plan context and confidently open or install
the app.

## Direction

Use one continuous focused-action route: discovery leads into shared planning,
then hands off to venue navigation. The memorable moment is the hero's solid
green route thread crossing three broad, open action states with oversized
ambient Lucide symbols. The invitation route reuses this grammar as one
full-screen state rather than a marketing card.

Approved north-star comp:
`.impeccable/mocks/homepage-route-thread.png`

Do not literalize the comp's unverified download claim or invented capability
copy. Implement its continuous route topology and scale with real copy, solid
color, and semantic CSS/SVG.

## Implementation fidelity inventory

| Ingredient         | Commitment                                                       | Medium                   |
| ------------------ | ---------------------------------------------------------------- | ------------------------ |
| Navigation         | Compact wordmark, two utility links, no floating shell           | Semantic HTML/CSS        |
| Hero               | Left-aligned large headline and one clear capability CTA         | Semantic HTML/CSS        |
| Route sequence     | Three open action states on one continuous solid route           | Semantic HTML/CSS + SVG  |
| Ambient symbols    | One oversized low-opacity Lucide symbol per state                | Inline SVG sprite        |
| Primary action     | Solid ComiNavi green capsule with arrow icon and visible focus   | Semantic link + SVG      |
| Capability story   | Seven existing facts grouped into preparation and venue acts     | Semantic sections/lists  |
| Shared-plan bridge | Factual collaboration context joining homepage to invite         | Semantic HTML/CSS        |
| Invitation states  | Valid and unavailable states share one open focused-action shell | Astro + CSS/SVG          |
| Motion             | Slow ambient symbol drift only; content visible by default       | CSS, reduced-motion safe |

## Component grammar

- Continuous capsule actions and status labels.
- Open layout fields; containment only where state requires it.
- Hairline separators, no heavy borders.
- Soft sparse elevation only on actionable controls.
- Rounded Japanese system type with semantic phrase breaks.

## Unresolved

The public App Store availability and launch date are intentionally not claimed
on the homepage. The invitation route continues to use its configured App Store
fallback.
