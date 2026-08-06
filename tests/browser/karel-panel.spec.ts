import { expect, test } from '@playwright/test'

test('renders runtime frames and releases subscriptions on browser unmount', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('img')).toHaveAttribute(
    'aria-label',
    /avenue 1, street 1/,
  )
  await expect(page.getByRole('status')).toHaveText('Ready')
  await page.getByRole('button', { name: 'Emit move' }).click()
  await expect(page.getByRole('img')).toHaveAttribute(
    'aria-label',
    /avenue 2, street 1/,
  )
  await expect(page.getByRole('status')).toHaveText('Running')

  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __karelBrowserTest: { stdoutListenerCount(): number }
        }
      ).__karelBrowserTest.stdoutListenerCount(),
    ),
  ).toBe(1)
  await page.evaluate(() =>
    (
      window as unknown as {
        __karelBrowserTest: { unmount(): void }
      }
    ).__karelBrowserTest.unmount(),
  )
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __karelBrowserTest: { stdoutListenerCount(): number }
        }
      ).__karelBrowserTest.stdoutListenerCount(),
    ),
  ).toBe(0)
})

test('registers through a real Web IDE host using only public APIs', async ({ page }) => {
  await page.goto('/host.html')

  await expect(page.getByText('KAREL TEST', { exact: true })).toBeVisible()
  const karelTab = page.getByRole('button', { name: 'Karel', exact: true })
  await expect(karelTab).toBeVisible()
  await karelTab.click()

  await expect(page.getByRole('heading', { name: 'First Steps' })).toBeVisible()
  await expect(page.getByRole('img', { name: /First Steps/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run Karel' })).toBeEnabled()
  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.getByText('main.py', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('karel.py', { exact: true })).toBeVisible()

  await page.evaluate(() =>
    (window as unknown as { __unmountKarelHost(): void }).__unmountKarelHost(),
  )
  await expect(page.locator('#root')).toBeEmpty()
})

test('runs a nested-module Karel program through the generic Python runtime session', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.goto('/host.html')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)

  await page.getByRole('button', { name: 'Karel', exact: true }).click()
  await page.getByRole('button', { name: 'Run Karel' }).click()

  await expect(page.getByRole('status')).toHaveText(/Complete|Stopped|Error/, {
    timeout: 150_000,
  })
  if ((await page.getByRole('status').textContent()) !== 'Complete') {
    const terminal = await page.locator('.xterm-rows').innerText()
    throw new Error(`Python runtime did not complete Karel:\n${terminal}`)
  }
  await expect(page.getByRole('img')).toHaveAttribute(
    'aria-label',
    /avenue 4, street 2, facing east/,
  )
})
