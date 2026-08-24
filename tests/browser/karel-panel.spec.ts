import { expect, test, type Locator } from '@playwright/test'

async function readPalette(panel: Locator) {
  return panel.evaluate((element) => {
    const style = getComputedStyle(element)
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas color sampling is unavailable')
    const sample = (color: string): [number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return [data[0]!, data[1]!, data[2]!]
    }
    const luminance = ([red, green, blue]: [number, number, number]) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const foreground = style.color
    const background = style.backgroundColor
    const foregroundLuminance = luminance(sample(foreground))
    const backgroundLuminance = luminance(sample(background))
    const lighter = Math.max(foregroundLuminance, backgroundLuminance)
    const darker = Math.min(foregroundLuminance, backgroundLuminance)
    return {
      background,
      foreground,
      contrast: (lighter + 0.05) / (darker + 0.05),
    }
  })
}

async function readSvgContrast(foreground: Locator, backgroundSelector: string) {
  return foreground.evaluate((element, selector) => {
    const background = element.closest('svg')?.querySelector(selector)
    if (!background) throw new Error(`Missing SVG background: ${selector}`)
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas color sampling is unavailable')
    const sample = (color: string): [number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return [data[0]!, data[1]!, data[2]!]
    }
    const luminance = ([red, green, blue]: [number, number, number]) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const foregroundLuminance = luminance(sample(getComputedStyle(element).fill))
    const backgroundLuminance = luminance(sample(getComputedStyle(background).fill))
    const lighter = Math.max(foregroundLuminance, backgroundLuminance)
    const darker = Math.min(foregroundLuminance, backgroundLuminance)
    return (lighter + 0.05) / (darker + 0.05)
  }, backgroundSelector)
}

test('renders runtime frames and releases subscriptions on browser unmount', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('img')).toHaveAttribute(
    'aria-label',
    /avenue 1, street 1/,
  )
  await expect(page.getByTestId('karel-robot-icon')).toHaveAttribute(
    'href',
    /(?:\/src\/assets\/karel\.png|^data:image\/png;base64,)/,
  )
  await expect(page.getByTestId('karel-robot')).toHaveAttribute(
    'transform',
    /rotate\(0\)/,
  )
  await expect(page.getByRole('status')).toHaveText('Ready')
  await page.getByRole('button', { name: 'Emit move' }).click()
  await expect(page.getByRole('img')).toHaveAttribute(
    'aria-label',
    /avenue 2, street 1, facing south/,
  )
  await expect(page.getByTestId('karel-robot')).toHaveAttribute(
    'transform',
    /rotate\(90\)/,
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
  ).toBe(2)
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

test('announces and navigates bounded history through visible controls', async ({
  page,
}) => {
  await page.goto('/')
  const panel = page.getByRole('region', { name: 'Karel world and playback' })
  await panel.getByRole('button', { name: 'Prepare & pause' }).click()
  await expect(panel.getByRole('status')).toHaveText('Paused')

  const emitMove = page.getByRole('button', { name: 'Emit move' })
  for (let event = 0; event < 5; event += 1) await emitMove.click()
  await expect(panel.getByText('2 older frames discarded within the memory limit')).toBeVisible()
  await expect(panel.getByText('Live frame 4 of 4')).toBeVisible()

  await panel.getByRole('button', { name: 'Step back' }).click()
  await expect(panel.getByRole('status')).toHaveText('History')
  await expect(panel.getByText('Recorded frame 3 of 4')).toBeVisible()
  await expect(panel.getByText(/Viewing recorded history/)).toBeVisible()
  await panel.getByRole('button', { name: 'Return to live' }).click()
  await expect(panel.getByRole('status')).toHaveText('Paused')
})

test('registers through a real Web IDE host using only public APIs', async ({ page }) => {
  await page.goto('/host.html')

  await expect(page.getByText('KAREL TEST', { exact: true })).toBeVisible()
  const karelTab = page.getByRole('tab', { name: 'Karel', exact: true })
  await expect(karelTab).toBeVisible()
  await expect(karelTab).toHaveAttribute('aria-selected', 'true')
  await karelTab.focus()
  await expect(karelTab).toBeFocused()

  await expect(page.getByRole('heading', { name: 'First Steps' })).toBeVisible()
  await expect(page.getByRole('img', { name: /First Steps/ })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Run controls' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Recorded history controls' })).toBeVisible()
  await expect(page.getByLabel('Karel runtime feedback')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run Karel' })).toBeEnabled()
  const panel = page.getByRole('region', { name: 'Karel world and playback' })
  const reset = panel.getByRole('button', { name: 'Reset', exact: true })
  await reset.focus()
  await page.keyboard.press('Enter')
  await expect(reset).toBeFocused()
  expect(await reset.evaluate((button) => getComputedStyle(button).outlineStyle)).toBe('solid')

  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.getByText('main.py', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('karel.py', { exact: true })).toHaveCount(0)
  await expect(sidebar.getByText('karel_world.json', { exact: true })).toHaveCount(0)

  await page.evaluate(() =>
    (window as unknown as { __unmountKarelHost(): void }).__unmountKarelHost(),
  )
  await expect(page.locator('#root')).toBeEmpty()
})

test('honors reduced motion and a high-zoom-equivalent narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 720 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const layout = await page.evaluate(() => {
    const controls = document.querySelector<HTMLElement>('.karel-playback-controls')
    const footer = document.querySelector<HTMLElement>('.karel-panel-footer')
    const robot = document.querySelector<SVGGElement>('.karel-world-robot')
    const viewport = document.querySelector<HTMLElement>('.karel-world-viewport')
    const icon = document.querySelector<SVGImageElement>('.karel-world-robot-icon')
    if (!controls || !footer || !robot || !viewport || !icon) {
      throw new Error('Karel layout is incomplete')
    }
    const controlsStyle = getComputedStyle(controls)
    return {
      controlsDisplay: controlsStyle.display,
      controlColumns: controlsStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
      footerDirection: getComputedStyle(footer).flexDirection,
      robotTransitionDuration: getComputedStyle(robot).transitionDuration,
      iconRendering: getComputedStyle(icon).imageRendering,
      worldWidth: viewport.getBoundingClientRect().width,
      worldHeight: viewport.getBoundingClientRect().height,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })

  expect(layout.controlsDisplay).toBe('grid')
  expect(layout.controlColumns).toBe(1)
  expect(layout.footerDirection).toBe('column')
  expect(layout.robotTransitionDuration).toBe('0s')
  expect(['pixelated', 'crisp-edges']).toContain(layout.iconRendering)
  expect(layout.worldWidth).toBeGreaterThan(300)
  expect(layout.worldHeight).toBeGreaterThan(150)
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
})

test('fits controls and labeled settings inside a narrow host-provided pane', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 820 })
  await page.goto('/host.html')
  await expect(page.getByRole('tab', { name: 'Karel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  const panel = page.getByRole('region', { name: 'Karel world and playback' })
  const layout = await panel.evaluate((element) => {
    const controls = element.querySelector<HTMLElement>('.karel-playback-controls')
    const settings = element.querySelector<HTMLElement>('.karel-control-settings')
    const worldViewport = element.querySelector<HTMLElement>('.karel-world-viewport')
    if (!controls || !settings || !worldViewport) {
      throw new Error('Karel responsive layout is incomplete')
    }
    return {
      panelClientWidth: element.clientWidth,
      panelScrollWidth: element.scrollWidth,
      controlsClientWidth: controls.clientWidth,
      controlsScrollWidth: controls.scrollWidth,
      settingsClientWidth: settings.clientWidth,
      settingsScrollWidth: settings.scrollWidth,
      worldWidth: worldViewport.getBoundingClientRect().width,
      worldHeight: worldViewport.getBoundingClientRect().height,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })

  expect(layout.panelClientWidth).toBeGreaterThan(0)
  expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelClientWidth)
  expect(layout.controlsScrollWidth).toBeLessThanOrEqual(layout.controlsClientWidth)
  expect(layout.settingsScrollWidth).toBeLessThanOrEqual(layout.settingsClientWidth)
  expect(layout.worldWidth).toBeCloseTo(layout.panelClientWidth, 0)
  expect(layout.worldHeight).toBeGreaterThanOrEqual(150)
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
  await expect(panel.getByText('Speed', { exact: true })).toBeVisible()
  await expect(panel.getByText('World', { exact: true })).toBeVisible()
})

test('follows the host theme and preserves readable panel contrast', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('web-ide.theme', 'dark')
  })
  await page.goto('/host.html')
  await expect(page.getByRole('tab', { name: 'Karel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  const panel = page.getByRole('region', { name: 'Karel world and playback' })
  const darkPalette = await readPalette(panel)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(darkPalette.contrast).toBeGreaterThanOrEqual(4.5)

  await page.getByRole('button', { name: 'Manage', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Light (Modern)', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const lightState = await readPalette(panel)

  expect(lightState.background).not.toBe(darkPalette.background)
  expect(lightState.foreground).not.toBe(darkPalette.foreground)
  expect(lightState.contrast).toBeGreaterThanOrEqual(4.5)

  await panel.getByTestId('karel-robot-icon').dispatchEvent('error')
  const fallback = panel.getByTestId('karel-robot-fallback')
  await expect(fallback).toBeVisible()
  expect(await readSvgContrast(fallback, '.karel-world-background')).toBeGreaterThanOrEqual(3)
})

test('runs a nested-module Karel program through the generic Python runtime session', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.goto('/host.html')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)

  await expect(page.getByRole('tab', { name: 'Karel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
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
  await expect(page.getByTestId('karel-robot')).toHaveAttribute(
    'transform',
    /rotate\(0\)/,
  )
  await expect(page.getByTestId('karel-robot-icon')).toBeVisible()
})

test('drives accessible line playback and recorded history through public services', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.goto('/host.html')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)

  await expect(page.getByRole('tab', { name: 'Karel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const panel = page.getByRole('region', { name: 'Karel world and playback' })
  const statusBar = page.getByRole('contentinfo', { name: 'Status bar' })
  const framePosition = panel.locator('.karel-frame-status > span').first()
  const retention = panel.locator('.karel-frame-status > span').nth(1)
  const world = panel.getByRole('img')
  await panel.getByRole('button', { name: 'Prepare & pause' }).click()
  await expect(panel.getByRole('status')).toHaveText('Paused', {
    timeout: 150_000,
  })
  await expect(panel.getByText(/Live frame \d+ of \d+/)).toBeVisible()
  await expect(page.getByRole('tab', { name: /^main\.py/u })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.monaco-editor .source-presentation-current-line')).toHaveCount(1)
  await expect(statusBar).toContainText('Paused at main.py:1')
  await expect(statusBar).toContainText('Ln 1, Col 1')

  const stepForward = panel.getByRole('button', { name: 'Step forward' })
  for (let step = 0; step < 16; step += 1) {
    const worldLabel = await world.getAttribute('aria-label')
    if (worldLabel?.includes('avenue 2, street 1')) break
    const previousRetention = await retention.textContent()
    await stepForward.click()
    await expect(retention).not.toHaveText(previousRetention ?? '', { timeout: 30_000 })
    if ((await panel.getByRole('status').textContent()) === 'Complete') {
      throw new Error(JSON.stringify({
        completedAtStep: step + 1,
        frame: await framePosition.textContent(),
        retention: await retention.textContent(),
        source: await statusBar.textContent(),
        world: await world.getAttribute('aria-label'),
      }))
    }
    await expect(panel.getByRole('status')).toHaveText('Paused', { timeout: 30_000 })
  }
  await expect(panel.getByText('Last action: move', { exact: true })).toBeVisible()
  await expect(world).toHaveAttribute('aria-label', /avenue 2, street 1/)

  const stepBack = panel.getByRole('button', { name: 'Step back' })
  for (let frame = 0; frame < 4; frame += 1) {
    const worldLabel = await world.getAttribute('aria-label')
    if (worldLabel?.includes('avenue 1, street 1')) break
    const previousFrame = await framePosition.textContent()
    await expect(stepBack).toBeEnabled()
    await stepBack.click()
    await expect(framePosition).not.toHaveText(previousFrame ?? '')
  }
  await expect(world).toHaveAttribute('aria-label', /avenue 1, street 1/)
  const previousFrame = await framePosition.textContent()
  await stepForward.click()
  await expect(framePosition).not.toHaveText(previousFrame ?? '')
  await expect(world).toHaveAttribute('aria-label', /avenue 2, street 1/)
  await expect(page.getByRole('tab', { name: /^steps\.py/u })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // The live debugger is paused at the loop header while recorded history
  // reveals the move() action's exact call site one line later.
  await expect(statusBar).toContainText('Paused at steps.py:5')
  await expect(statusBar).toContainText('Ln 6, Col 1')
  await expect(page.locator('.monaco-editor .source-presentation-historical-line')).toHaveCount(1)
  await expect(panel.getByRole('status')).toHaveText('History')
  await expect(panel.getByText(/Viewing recorded history/)).toBeVisible()

  await panel.getByRole('button', { name: 'Return to live' }).click()
  await expect(panel.getByRole('status')).toHaveText('Paused')
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByRole('status')).toHaveText('Stopped', {
    timeout: 30_000,
  })
})
