import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "../src/components/pages/HomePage";
import PrivacyPage from "../src/components/pages/PrivacyPage";

test("the homepage body is server-rendered from TSX with all seven features", () => {
  const markup = renderToStaticMarkup(createElement(HomePage));
  assert.match(markup, /<main class="home">/);
  assert.equal(markup.match(/class="feature-item"/g)?.length, 7);
  assert.match(markup, /コミケ非公式<wbr\/>ナビゲーション<wbr\/>アプリ/);
  assert.match(markup, /プライバシー \/ Privacy/);
});

test("the privacy body is server-rendered from TSX in Japanese and English", () => {
  const markup = renderToStaticMarkup(createElement(PrivacyPage));
  assert.match(markup, /<main class="privacy">/);
  assert.equal(markup.match(/class="privacy__number"/g)?.length, 5);
  assert.match(markup, /プライバシーポリシー/);
  assert.match(markup, /<h2>Privacy Policy<\/h2>/);
  assert.match(markup, /hello@mikunet\.llc/);
});

test("Astro pages are thin zero-hydration wrappers around TSX", async () => {
  const [home, privacy] = await Promise.all([
    readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/privacy.astro", import.meta.url), "utf8"),
  ]);
  assert.match(home, /<HomePage \/>/);
  assert.match(privacy, /<PrivacyPage \/>/);
  assert.doesNotMatch(`${home}\n${privacy}`, /client:/);
});
