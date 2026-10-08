import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
test('complete human room lifecycle at desktop and mobile', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pair = await request.post('/local/pair', {
    headers: { authorization: 'Bearer browser-fixture-control' },
    data: {},
  });
  const code = (await pair.json()).code;
  await page.goto('/');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Connect to Converoom' }).click();
  await page.getByRole('button', { name: 'Create room', exact: true }).first().click();
  await page.getByLabel('Room name').fill('Acceptance room');
  await page.getByLabel('Objective').fill('Review the coding design');
  await page.getByRole('button', { name: 'Create room', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Acceptance room' })).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByLabel('Public message').fill('Public opening position');
  await page.getByRole('button', { name: 'Post message' }).click();
  await expect(page.getByText('Public opening position', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByLabel('Agent name').fill('Codex reviewer');
  await page.getByRole('button', { name: 'Add agent', exact: true }).last().click();
  await expect(
    page
      .getByRole('complementary', { name: 'Agents and turns' })
      .getByText('Codex reviewer', { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Allow requests', exact: true }).click();
  await page.getByRole('button', { name: 'Allow turn requests', exact: true }).click();
  await page.getByRole('button', { name: 'Request turn', exact: true }).click();
  await page.getByLabel('Assigned prompt').fill('Review the opening position');
  await page.getByRole('button', { name: 'Request managed turn', exact: true }).click();
  await page.getByRole('button', { name: /Approvals/ }).click();
  await expect(page.getByText('turn execute', { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Review and grant' }).click();
  await page.getByRole('button', { name: 'Grant permission' }).click();
  await expect(page.getByText('No approvals waiting')).toBeVisible();
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  await page.getByRole('button', { name: 'Tasks and evidence', exact: true }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Room controls', exact: true }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Pause room', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.screenshot({
    path: '.artifacts/screenshots/' + info.project.name + '-room.png',
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Resume room', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Close room', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Post message' })).toBeDisabled();
  expect(errors).toEqual([]);
});
