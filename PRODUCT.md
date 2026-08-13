# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Comiket attendees use ComiNavi while preparing for an event and while moving
through the venue. They need to discover circles, understand what interests
them, preserve that intent, and find the right place on the day without losing
the context they gathered beforehand.

Shared Plan invitation recipients are a second public-web audience. They need
to understand which plan and Comiket they are joining, what collaboration
allows, and how to continue safely in the app.

## Product Purpose

ComiNavi connects catalog exploration, circle research, saved intent, Shared
Plans, and venue navigation. Success means the work someone does before
Comiket remains useful when they are standing in the venue with limited time
and attention.

## Positioning

ComiNavi turns a catalog from a reference to browse into a continuous path from
discovery, through collaborative planning, to finding the circle in the venue.
Shared Plans are the primary planning model; Circle.ms favorites remain an
optional compatibility destination.

## Operating Context

- Before the event: browse cuts, search circles and creators, inspect details,
  save notes and intent, and coordinate Shared Plans.
- At the venue: switch days and halls, understand the map, locate saved circles,
  and follow the prepared plan.
- From a public invite link: review non-secret plan context, install or open the
  app, authenticate, and confirm the joining identity before admission.

## Capabilities and Constraints

- The homepage describes an iPhone and iPad app that is still in development.
- Public invitation routes must remain useful without the app and show plan and
  Comiket context, privacy expectations, a TestFlight action, and an explicit
  `cominavi://join/<token>` fallback.
- Invitation links are reusable capabilities and never imply one fixed
  recipient before authentication.
- Public copy must not invent availability, customer, performance, or launch
  claims that the repository does not establish.

## Brand Commitments

- Product name: ComiNavi / コミナビ.
- Public Japanese copy is direct, calm, and practical, with moments of warmth
  grounded in the anticipation of finding creators and works at Comiket.
- The iOS focused-action surfaces are the cross-surface visual authority:
  rounded system typography, strong left alignment, generous space, calm
  secondary text, capsule actions, and oversized ambient Lucide symbols.
- ComiNavi green `#A3D21B` is the sole primary accent. Gradients, cream-paper
  styling, broadsheet/editorial treatment, heavy black outlines, offset print
  shadows, decorative glassmorphism, and generic card stacks are excluded.

## Evidence on Hand

- Existing public copy and seven factual capability descriptions in
  `server/src/components/pages/HomePage.tsx`.
- Current invitation requirements and states in
  `server/src/pages/join/[token].astro`.
- The incumbent focused-action components in
  `ios/ComiNavi/DownloadProgressView.swift` and their use in catalog recovery
  and X followed-circle import flows.
- App Store screenshots exist for map, explore, and location surfaces, but no
  approved marketing testimonials, launch date, or public performance claims
  are present.

## Product Principles

1. Carry intent from discovery to the venue.
2. Make the next action unmistakable without flattening the experience.
3. Keep collaboration explicit, trusted, and understandable.
4. Let product state and real capability provide the proof.
5. Preserve calm under event-day time pressure.

## Accessibility & Inclusion

Public surfaces must support semantic structure, keyboard navigation, visible
focus, comfortable touch targets, sufficient contrast, responsive Japanese
line breaking, reduced motion, and practical use on phone, tablet, and desktop.
