import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
const catalog = JSON.parse(readFileSync("data/public/catalog.json", "utf8"));
const editorial = JSON.parse(
  readFileSync("data/public/editorial.json", "utf8")
);
const slug: string = catalog[0].slug;
const selection: string = editorial.homeSelectionIds[0];
const routes = [
  "",
  "filmes/",
  `filmes/${slug}/`,
  "selecoes/",
  `selecoes/${selection}/`,
  "como-baixar/",
  "sobre/",
  "404.html",
];
for (const locale of ["", "en/"]) {
  for (const route of routes) {
    const target = locale + (locale && route === "404.html" ? "404/" : route);
    test(`${target || "home"}: navigation, language and WCAG 2.2 AA automated audit`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(
        (preference) => localStorage.setItem("pvca-language", preference),
        locale ? "pt-BR" : "en"
      );
      await page.goto(target);
      await expect(page.locator(".menu-toggle")).not.toHaveAttribute("hidden");
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        locale ? "en" : "pt-BR"
      );
      expect(new URL(page.url()).pathname).toBe(`/acervo-pvca/${target}`);
      await expect(
        page.locator(
          `.language-switch [data-language="${locale ? "en" : "pt-BR"}"]`
        )
      ).toHaveAttribute("aria-current", "page");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
      await page.locator(".name").click();
      await expect(page.locator("h1")).toContainText(
        locale ? "My personal" : "Meu acervo"
      );
      expect(errors).toEqual([]);
    });
  }
}
test("catalog search, both filters, sort, grid/list and counts", async ({
  page,
}) => {
  await page.goto("filmes/");
  await expect(page.locator("#resultCount")).toHaveText(
    `${catalog.length} filmes`
  );
  const order = await page
    .locator(".film-card")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("href")));
  await page.evaluate(() => {
    Object.assign(window, { catalogChanges: 0 });
    new MutationObserver((records) => {
      for (const r of records)
        if (r.type === "childList")
          Object.assign(window, {
            catalogChanges: Reflect.get(window, "catalogChanges") + 1,
          });
    }).observe(document.querySelector("#catalog")!, { childList: true });
  });
  await page.locator("#filmSearch").fill("tokyo");
  expect(
    await page.locator(".film-card:not([hidden])").count()
  ).toBeGreaterThan(0);
  for (const [filter, key, value] of [
    ["ptbr", "ptbr", "true"],
    ["4k", "resolution", "2160p"],
  ]) {
    await page.locator("#filmSearch").fill("");
    await page.locator(`[data-filter="${filter}"]`).click();
    const visible = page.locator(".film-card:not([hidden])");
    const count = await visible.count();
    expect(count).toBeGreaterThan(0);
    expect(
      await visible.evaluateAll(
        (cards, { key, value }) =>
          cards.every((card) => card.getAttribute(`data-${key}`) === value),
        { key, value }
      )
    ).toBe(true);
    await expect(page.locator("#resultCount")).toHaveText(
      `${count} ${count === 1 ? "filme" : "filmes"}`
    );
  }
  expect(await page.evaluate(() => Reflect.get(window, "catalogChanges"))).toBe(
    0
  );
  expect(
    await page
      .locator(".film-card")
      .evaluateAll((cards) => cards.map((card) => card.getAttribute("href")))
  ).toEqual(order);
  await page.locator("#filmSort").selectOption("year-desc");
  const years = await page
    .locator(".film-card")
    .evaluateAll((cards) =>
      cards.map((card) => Number(card.getAttribute("data-year")))
    );
  expect(years).toEqual([...years].sort((a, b) => b - a));
  await page.locator('[data-view="list"]').click();
  await expect(page.locator("#catalog")).toHaveAttribute("data-view", "list");
  await page.locator('[data-view="grid"]').click();
  await expect(page.locator("#catalog")).toHaveAttribute("data-view", "grid");
  await page.locator("#filmSearch").fill("no-film-xyz");
  await expect(page.locator("#resultCount")).toHaveText("0 filmes");
  await expect(page.locator("#emptyCatalog")).toBeVisible();
});
test("manual locale switching preserves equivalent path, query and fragment", async ({
  page,
}) => {
  await page.goto(`filmes/${slug}/?q=tokyo#main`);
  for (const lang of ["en", "pt-BR"]) {
    await page.locator(`[data-language="${lang}"]`).click();
    expect(new URL(page.url()).pathname).toBe(
      `/acervo-pvca/${lang === "en" ? "en/" : ""}filmes/${slug}/`
    );
    expect(new URL(page.url()).search).toBe("?q=tokyo");
    expect(new URL(page.url()).hash).toBe("#main");
  }
});
test("mobile menu, keyboard focus, skip link and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("filmes/");
  const toggle = page.locator(".menu-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    await page
      .locator("main")
      .evaluate((main) => main instanceof HTMLElement && main.inert)
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations
  ).toEqual([]);
  await page.locator("#main-navigation a").last().focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  expect(
    await page
      .locator("main")
      .evaluate((main) => main instanceof HTMLElement && main.inert)
  ).toBe(false);
  await toggle.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");
  await page.locator("#filmSearch").focus();
  expect(
    await page
      .locator("#filmSearch")
      .evaluate((el) => getComputedStyle(el).outlineWidth)
  ).toBe("2px");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await toggle.evaluate((el) => getComputedStyle(el).transitionDuration)
  ).toBe("0s");
});
test("Pages fallback returns a bilingual 404 without redirecting", async ({
  page,
}) => {
  const response = await page.goto("en/unknown-path/");
  expect(response?.status()).toBe(404);
  expect(new URL(page.url()).pathname).toBe("/acervo-pvca/en/unknown-path/");
  await expect(page.locator("h1")).toHaveText("Página não encontrada");
  await expect(page.locator('main [lang="en"]')).toContainText(
    "Page not found"
  );
  await page.locator('[data-language="en"]').click();
  await expect(page.locator("h1")).toHaveText("Page not found");
});
