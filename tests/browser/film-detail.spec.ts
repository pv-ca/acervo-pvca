import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const width of [375, 1440]) {
  test(`film detail at ${width}px keeps synopsis close and associates each copy with its access`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("filmes/heaven-s-gate-1980/");
    const copies = page.locator(".archive-copy");
    await expect(copies).toHaveCount(2);
    await expect(page.locator("[data-share]")).toHaveText("Compartilhar filme");
    await expect(copies.locator(".copy-spec")).toHaveText([
      "1080p · 42,2 GiB",
      "1080p · 42,2 GiB",
    ]);
    await expect(page.locator(".archive-card")).not.toContainText(
      /Matroska|MKV|MP4\/MOV/
    );
    await expect(copies.nth(0).locator("h3")).toHaveText("Cópia do Drive");
    await expect(copies.nth(0).locator("a")).toHaveAttribute(
      "href",
      /^https:\/\/drive\.google\.com\//
    );
    await expect(copies.nth(1).locator("h3")).toHaveText("Cópia do Archive");
    await expect(copies.nth(1).locator("a.archive-action")).toHaveAttribute(
      "href",
      /^https:\/\/archive\.org\//
    );
    const geometry = await page.evaluate(() => {
      const heading = document
        .querySelector(".detail-heading")!
        .getBoundingClientRect();
      const editorial = document
        .querySelector(".detail-editorial")!
        .getBoundingClientRect();
      const poster = document
        .querySelector(".detail-poster")!
        .getBoundingClientRect();
      const card = document
        .querySelector(".archive-card")!
        .getBoundingClientRect();
      const titleStyle = getComputedStyle(document.querySelector("h1")!);
      return {
        gap: editorial.top - heading.bottom,
        heading: { top: heading.top, bottom: heading.bottom },
        editorial: { top: editorial.top, bottom: editorial.bottom },
        poster: { top: poster.top, bottom: poster.bottom },
        card: { top: card.top, bottom: card.bottom },
        family: titleStyle.fontFamily,
        bodyFamily: getComputedStyle(document.body).fontFamily,
        weight: titleStyle.fontWeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.family).toBe(geometry.bodyFamily);
    expect(geometry.weight).toBe("560");
    if (width > 760) {
      expect(geometry.gap).toBeGreaterThanOrEqual(24);
      expect(geometry.gap).toBeLessThanOrEqual(40);
    } else {
      expect(geometry.poster.top).toBeGreaterThan(geometry.heading.bottom);
      expect(geometry.editorial.top).toBeGreaterThan(geometry.poster.bottom);
      expect(geometry.card.top).toBeGreaterThan(geometry.editorial.bottom);
    }
    await page.locator(".detail-selections").scrollIntoViewIfNeeded();
    const cards = page.locator(".selection-grid a");
    expect(await cards.count()).toBeGreaterThan(0);
    for (const card of await cards.all()) {
      await expect(card.locator("img")).toHaveCount(3);
      for (const image of await card.locator("img").all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((element: HTMLImageElement) => element.decode());
        await expect(image).toHaveAttribute("alt", "");
      }
    }
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });
}

test("detail retains original diacritics, omits duplicate titles and preserves deduplicated access", async ({
  page,
}) => {
  await page.goto("filmes/4-months-3-weeks-and-2-days-2007/");
  await expect(page.locator("h1")).toHaveText("4 Meses, 3 Semanas e 2 Dias");
  await expect(page.locator(".original-title")).toHaveText(
    "4 luni, 3 săptămâni și 2 zile"
  );
  await page.goto("en/filmes/heaven-s-gate-1980/");
  await expect(page.locator(".archive-copy h3")).toHaveText([
    "Drive copy",
    "Archive copy",
  ]);
  await page.goto("filmes/hatari-1962/");
  await expect(page.locator(".original-title")).toHaveCount(0);
  await page.goto("filmes/sound-and-fury-1988/");
  await expect(page.locator("h1")).toHaveText("Som e fúria");
  // The 1080p Archive copy replaced the 576p copies.
  await expect(page.locator(".archive-copy")).toHaveCount(1);
  await expect(page.locator(".archive-copy a.archive-action")).toHaveAttribute(
    "href",
    "https://archive.org/details/de-bruit-et-de-fureur-1988-1080p-pvca"
  );
});

test("share copies the canonical locale URL and offers a manual fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (url: string) => {
          document.documentElement.dataset.copied = url;
        },
      },
    });
  });
  await page.goto("en/filmes/heaven-s-gate-1980/?source=example");
  await page.locator("[data-share]").click();
  const canonical =
    "https://pv-ca.github.io/acervo-pvca/en/filmes/heaven-s-gate-1980/";
  await expect(page.locator("html")).toHaveAttribute("data-copied", canonical);
  await expect(page.locator(".share-feedback")).toHaveText("Link copied");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    })
  );
  await page.locator("[data-share]").click();
  await expect(page.locator(".share-url")).toBeVisible();
  await expect(page.locator(".share-url")).toHaveValue(canonical);
  await expect(page.locator(".share-url")).toBeFocused();
});
