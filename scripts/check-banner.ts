import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const variants = ['docs/media/banner-dark.svg', 'docs/media/banner-light.svg'];

async function checkVariant(page: Page, file: string): Promise<void> {
    const asset = await readFile(file, 'utf8');
    assert.ok(!/<(?:script|foreignObject|image)\b/i.test(asset), `${file} has no scripts or embedded content`);
    assert.ok(!/https?:\/\//.test(asset.replace('http://www.w3.org/2000/svg', '')), `${file} loads nothing external`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent(asset);
    const packet = page.locator('.inbound').first();
    const first = await packet.evaluate((element) => getComputedStyle(element).transform);
    await page.waitForTimeout(1600);
    assert.notEqual(await packet.evaluate((element) => getComputedStyle(element).transform), first, `${file} animates`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, `${file} honors reduced motion`);
    await page.setContent(`<img src="data:image/svg+xml;base64,${Buffer.from(asset).toString('base64')}">`);
    await page.locator('img').evaluate(async (element: HTMLImageElement) => {
        await element.decode();
        if (element.naturalWidth !== 1280 || element.naturalHeight !== 400) throw new Error('SVG image failed to render');
    });
}

await mkdir('.data', { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(resolve('.data/banner-validation-browser'), {
    executablePath: process.env.AIBINATOR_CHROME ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--disable-dev-shm-usage'],
    env: { ...process.env, TMPDIR: resolve('.data'), XDG_CACHE_HOME: resolve('.data/banner-validation-cache') },
});
try {
    const page = await context.newPage();
    for (const file of variants) await checkVariant(page, file);
    console.log('Banner validation passed: dark and light variants decode, animate, honor reduced motion, and load nothing external.');
} finally {
    await context.close();
    await rm('.data/banner-validation-browser', { recursive: true, force: true });
    await rm('.data/banner-validation-cache', { recursive: true, force: true });
}
