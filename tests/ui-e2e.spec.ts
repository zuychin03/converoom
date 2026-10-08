import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
const axe = async (page: Page) =>
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);
test('complete human room lifecycle at desktop and mobile', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pair = await request.post('http://127.0.0.1:43318/pair');
  const code = (await pair.json()).code;
  await page.goto('/');
  await axe(page);
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Connect to Converoom' }).click();
  await page.getByRole('button', { name: 'Create room', exact: true }).first().click();
  await page.getByLabel('Room name').fill('Acceptance room');
  await page.getByLabel('Objective').fill('Review the coding design');
  await page.getByRole('button', { name: 'Create room', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Acceptance room' })).toBeVisible();
  await axe(page);
  await page.getByLabel('Public message').fill('Public opening position');
  await page.getByRole('button', { name: 'Post message' }).click();
  await expect(page.getByText('Public opening position', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByLabel('Agent name').fill('Codex reviewer');
  await page.getByRole('button', { name: 'Add agent', exact: true }).last().click();
  const agents = page.getByRole('complementary', { name: 'Agents and turns' });
  await expect(agents.getByText('Codex reviewer', { exact: true }).first()).toBeVisible();
  const consent = agents.getByRole('switch', { name: 'Allow turn requests' });
  await consent.click();
  await expect(consent).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Request turn', exact: true }).click();
  await page.getByLabel('Assigned prompt').fill('Review the opening position');
  await page.getByRole('button', { name: 'Request managed turn', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  const composer = await page.getByLabel('Public message').boundingBox();
  expect((composer?.y ?? Infinity) + (composer?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height);
  await axe(page);
  await page.getByRole('button', { name: /Approvals/ }).click();
  await expect(page.getByText('turn execute', { exact: true })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Review and grant' }).click();
  await page.getByRole('button', { name: 'Grant permission' }).click();
  await expect(page.getByText('No approvals waiting')).toBeVisible();
  const roomId = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    return state.rooms.find((room: { title: string; status: string }) => room.title === 'Acceptance room' && room.status === 'open').id as string;
  });
  expect((await request.post('http://127.0.0.1:43318/workspace?roomId=' + encodeURIComponent(roomId))).ok()).toBe(true);
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect reservation' }).click();
  await expect(page.getByRole('dialog', { name: 'Inspect and release reservation' })).toBeVisible();
  expect(await page.getByRole('dialog', { name: 'Inspect and release reservation' }).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await axe(page);
  await page.getByLabel('Inspection and retained-work handoff').fill('Inspected retained work; no worker was dispatched');
  await page.screenshot({ path: '.artifacts/screenshots/' + info.project.name + '-reservation.png', fullPage: true });
  await page.getByRole('button', { name: 'Release reservation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect reservation' })).toBeHidden();
  await expect(page.getByText('Rework requested', { exact: true })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Room', exact: true }).click();
  await page.getByText('Room controls', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set agenda' })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Open index' }).click();
  const index = page.getByRole('dialog', { name: 'Index' });
  await expect(index).toBeVisible();
  await page.getByRole('combobox', { name: 'Search rooms, entry numbers and actions' }).fill('opening');
  await expect(index.getByRole('option').first()).toContainText('Public opening position');
  await page.keyboard.press('Escape');
  await expect(index).toBeHidden();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await axe(page);
  await page.screenshot({
    path: '.artifacts/screenshots/' + info.project.name + '-room.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Close room', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Post message' })).toBeDisabled();
  expect(errors).toEqual([]);
});
