import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
const axe = async (page: Page) =>
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);
test('independent owners complete shared consent, review, denial, revocation and reconnect', async ({ page, browser, request }, info) => {
  const participantContext = await browser.newContext({ viewport: page.viewportSize()! });
  const shared = await participantContext.newPage(), local = await participantContext.newPage();
  const errors: string[] = []; for (const p of [page, shared, local]) p.on('pageerror', (e) => errors.push(e.message));
  const title = 'Shared browser ' + info.project.name;
  const declinePrompt = 'Decline fixture ' + info.project.name, denyPrompt = 'Deny local execution ' + info.project.name;
  try {
    const pairCode = (await (await request.post('http://127.0.0.1:43318/pair')).json()).code;
    await page.goto('/'); await page.getByLabel('Pairing code').fill(pairCode); await page.getByRole('button', { name: 'Connect to Converoom' }).click();
    await page.getByRole('button', { name: 'Create room', exact: true }).first().click(); await page.getByLabel('Room name').fill(title);
    await page.getByLabel('Objective').fill('Independent public review'); await page.getByRole('button', { name: 'Create room', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    const roomId = await page.locator('.record-id code').innerText();
    async function invite() {
      await page.getByRole('button', { name: 'Invite participant', exact: true }).click(); await page.getByLabel('Participant name').fill('Windows participant');
      await page.getByRole('button', { name: 'Create invitation' }).click(); return page.getByTestId('invitation-code').innerText();
    }
    const code = await invite(); await axe(page);
    await shared.goto('https://room.example.ts.net:43319/shared'); await axe(shared);
    await shared.getByLabel('Shared room ID').fill(roomId); await shared.getByLabel('Invitation code').fill(code);
    await shared.getByRole('button', { name: 'Redeem invitation' }).click(); await expect(shared.getByRole('heading', { name: 'Confirmation pending' })).toBeVisible();
    await expect(shared.getByLabel('Public message')).toBeHidden(); await axe(shared);
    await page.getByRole('button', { name: 'Refresh state' }).click(); await page.getByRole('button', { name: 'Confirm participant', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm participant' }); await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(page.getByRole('button', { name: 'Confirm participant' })).toBeFocused();
    await page.getByRole('button', { name: 'Confirm participant', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm participant' }).click();
    await expect(shared.getByRole('heading', { name: title })).toBeVisible();
    await shared.getByLabel('Public message').fill('Participant public position'); await shared.getByRole('button', { name: 'Post message' }).click();
    await shared.getByRole('button', { name: 'Artefacts', exact: true }).click(); await shared.getByLabel('Reviewed public content').fill('Public Markdown review fixture');
    await shared.getByRole('button', { name: 'Review publication' }).click(); await shared.getByRole('button', { name: 'Publish to room' }).click();
    await shared.getByRole('button', { name: 'Read review.md' }).click(); await expect(shared.getByRole('region', { name: 'Artefact content' })).toContainText('Public Markdown review fixture');
    await shared.getByRole('button', { name: 'Review Markdown history page' }).click(); await expect(shared.getByRole('heading', { name: 'Bounded Markdown history page' })).toBeVisible(); await axe(shared);
    const localCode = (await (await request.post('http://127.0.0.1:43318/pair?participant=1')).json()).code;
    await local.goto('http://127.0.0.1:43320'); await local.getByLabel('Pairing code').fill(localCode); await local.getByRole('button', { name: 'Connect to Converoom' }).click();
    await local.getByRole('button', { name: 'Connections', exact: true }).click(); await local.getByRole('button', { name: 'Connect private room', exact: true }).click();
    await local.getByLabel('Private HTTPS origin').fill('https://room.example.ts.net:43319'); await local.getByLabel('Shared room ID').fill(roomId);
    await local.getByRole('button', { name: 'Prepare connection' }).click();
    const link = local.getByRole('link', { name: 'Approve room connection' }); await expect(link).toBeVisible();
    const [approval] = await Promise.all([participantContext.waitForEvent('page'), link.click()]);
    const review = approval.getByRole('link', { name: 'Review bridge access' });
    await review.or(approval.getByRole('button', { name: 'Allow room connection' })).first().waitFor();
    if (await review.isVisible()) await review.click();
    await approval.getByRole('button', { name: 'Allow room connection' }).click(); await expect(approval.locator('body')).toContainText('Room connected'); await approval.close();
    await local.getByRole('button', { name: 'Refresh state' }).click(); await expect(local.getByRole('button', { name: 'Enable managed discussion' })).toBeVisible();
    await local.getByRole('button', { name: 'Enable managed discussion' }).click(); await local.getByRole('button', { name: 'Enable managed discussion' }).last().click();
    await shared.getByRole('button', { name: 'Members', exact: true }).click(); await shared.getByRole('button', { name: 'Refresh', exact: true }).click();
    await shared.getByRole('checkbox', { name: 'Room owner', exact: true }).check(); await shared.getByRole('button', { name: 'Save room consent' }).click(); await axe(shared);
    await page.getByRole('button', { name: 'Room', exact: true }).click(); await page.getByRole('button', { name: 'Refresh state' }).click();
    await page.getByRole('button', { name: 'Request turn', exact: true }).click(); await page.getByLabel('Assigned prompt').fill(declinePrompt);
    await page.getByRole('button', { name: 'Request participant turn', exact: true }).click();
    await local.getByRole('button', { name: 'Refresh state' }).click(); await expect(local.getByRole('heading', { name: declinePrompt })).toBeVisible({ timeout: 15000 });
    await local.getByRole('button', { name: 'Decline proposal', exact: true }).click(); await local.getByRole('dialog').getByRole('button', { name: 'Decline proposal' }).click();
    await page.getByRole('button', { name: 'Request turn', exact: true }).click(); await page.getByLabel('Assigned prompt').fill(denyPrompt);
    await page.getByRole('button', { name: 'Request participant turn', exact: true }).click(); await local.getByRole('button', { name: 'Refresh state' }).click();
    const proposal = local.getByRole('region', { name: 'Incoming proposal' }).filter({ hasText: denyPrompt }); await expect(proposal).toBeVisible({ timeout: 15000 });
    await proposal.getByRole('button', { name: 'Accept proposal' }).click(); await local.getByRole('dialog').getByRole('button', { name: 'Accept proposal' }).click();
    await local.getByRole('button', { name: /Approvals/ }).click(); await axe(local); await local.getByRole('button', { name: 'Deny', exact: true }).click(); await local.getByRole('button', { name: 'Deny request', exact: true }).click();
    expect((await (await request.get('http://127.0.0.1:43318/native-count')).json()).nativeStarts).toBe(0);
    await local.getByRole('button', { name: 'Connections', exact: true }).click(); await local.getByRole('button', { name: 'Disconnect locally' }).click(); await local.getByRole('dialog').getByRole('button', { name: 'Disconnect locally' }).click();
    await page.getByRole('button', { name: 'Members', exact: true }).click(); await page.getByRole('button', { name: 'Remove participant', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Remove participant' }).click();
    await expect(shared.getByRole('heading', { name: 'Join your private room' })).toBeVisible(); await expect(shared.getByText('Public Markdown review fixture', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Recover identity', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Create recovery code' }).click();
    const nextCode = (await page.getByTestId('invitation-code').textContent())!.trim();
    await shared.getByLabel('Invitation code').fill(nextCode); await shared.getByLabel('Recover my existing identity').check(); await shared.getByRole('button', { name: 'Redeem invitation' }).click();
    await page.getByRole('button', { name: 'Refresh state' }).click(); await page.getByRole('button', { name: 'Confirm participant', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Confirm participant' }).click();
    await expect(shared.getByRole('heading', { name: title })).toBeVisible(); await axe(shared);
    await expect(shared.getByRole('button', { name: 'Cancel turn' })).toHaveCount(0);
    for (const [label, p] of [['members', page], ['participant', shared], ['connections', local]] as const) {
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await p.screenshot({ path: '.artifacts/screenshots/' + info.project.name + '-shared-' + label + '.png', fullPage: true });
    }
    await page.getByRole('button', { name: 'Room', exact: true }).click(); await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close room', exact: true }).click();
    expect(errors).toEqual([]);
  } finally { await participantContext.close(); }
});
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
