const MESSAGE_TYPE = 'VITE_AUTO_HEIGHT'

function getContentHeight() {
  const root =
    document.getElementById('root')

  const appShell =
    document.querySelector('.app-shell')

  const body =
    document.body

  const html =
    document.documentElement

  const heights = [0]

  if (root) {
    heights.push(
      root.scrollHeight,
      root.offsetHeight,
      root.getBoundingClientRect().height,
    )
  }

  if (appShell) {
    const rect =
      appShell.getBoundingClientRect()

    heights.push(
      appShell.scrollHeight,
      appShell.offsetHeight,
      rect.height,
      rect.bottom + window.scrollY,
    )
  }

  if (body) {
    heights.push(
      body.scrollHeight,
      body.offsetHeight,
    )
  }

  if (html) {
    heights.push(
      html.scrollHeight,
      html.offsetHeight,
    )
  }

  return Math.ceil(
    Math.max(...heights),
  )
}

export function initWixAutoHeight() {
  if (
    typeof window === 'undefined' ||
    window.parent === window
  ) {
    return
  }

  let lastHeight = 0
  let animationFrame = null

  const timeoutIds = []
  const trackedImages = []

  const sendHeight = (
    force = false,
  ) => {
    if (
      animationFrame !== null
    ) {
      cancelAnimationFrame(
        animationFrame,
      )
    }

    animationFrame =
      requestAnimationFrame(() => {
        animationFrame = null

        const height =
          getContentHeight()

        if (
          !Number.isFinite(height) ||
          height < 100
        ) {
          return
        }

        if (
          !force &&
          height === lastHeight
        ) {
          return
        }

        lastHeight = height

        window.parent.postMessage(
          {
            type: MESSAGE_TYPE,
            height,
            pathname:
              window.location.pathname,
          },
          '*',
        )
      })
  }

  const scheduleMeasurements = () => {
    ;[
      0,
      50,
      100,
      250,
      500,
      1000,
      1500,
      2500,
    ].forEach((delay) => {
      if (delay === 0) {
        sendHeight(true)
        return
      }

      const id =
        window.setTimeout(
          () => {
            sendHeight(true)
          },
          delay,
        )

      timeoutIds.push(id)
    })
  }

  /*
    Initial measurements.

    The Mites page initially shows
    "Loading schedule…" and then
    replaces it with data from the
    Google Apps Script API, so we
    measure repeatedly during startup.
  */
  scheduleMeasurements()

  const root =
    document.getElementById(
      'root',
    )

  const appShell =
    document.querySelector(
      '.app-shell',
    )

  /*
    ResizeObserver catches:
    - API schedule load
    - Mite B / Mite C tab changes
    - responsive layout changes
    - mobile agenda height changes
    - parking image sizing
    - old games disappearing
  */
  const resizeObserver =
    new ResizeObserver(() => {
      sendHeight()
    })

  if (root) {
    resizeObserver.observe(
      root,
    )
  }

  if (
    appShell &&
    appShell !== root
  ) {
    resizeObserver.observe(
      appShell,
    )
  }

  /*
    MutationObserver gives us another
    signal whenever React replaces,
    adds, or removes schedule content.
  */
  const mutationObserver =
    new MutationObserver(() => {
      sendHeight()
    })

  if (root) {
    mutationObserver.observe(
      root,
      {
        childList: true,
        subtree: true,
        characterData: true,
      },
    )
  }

  const handleResize = () => {
    sendHeight(true)

    ;[
      50,
      100,
      250,
      500,
      750,
      1000,
    ].forEach((delay) => {
      const id =
        window.setTimeout(
          () => {
            sendHeight(true)
          },
          delay,
        )

      timeoutIds.push(id)
    })
  }

  const handleLoad = () => {
    scheduleMeasurements()
  }

  window.addEventListener(
    'resize',
    handleResize,
  )

  window.addEventListener(
    'orientationchange',
    handleResize,
  )

  window.addEventListener(
    'load',
    handleLoad,
  )

  /*
    The parking map and Wings logo
    can alter the final page height
    after their assets finish loading.
  */
  document
    .querySelectorAll('img')
    .forEach((image) => {
      if (!image.complete) {
        trackedImages.push(image)

        image.addEventListener(
          'load',
          sendHeight,
        )

        image.addEventListener(
          'error',
          sendHeight,
        )
      }
    })

  /*
    Oswald comes from Google Fonts,
    so measure again once the web
    font is ready. Font substitution
    can change wrapping and therefore
    page height.
  */
  if (document.fonts?.ready) {
    document.fonts.ready
      .then(() => {
        sendHeight(true)
      })
      .catch(() => {})
  }

  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()

    window.removeEventListener(
      'resize',
      handleResize,
    )

    window.removeEventListener(
      'orientationchange',
      handleResize,
    )

    window.removeEventListener(
      'load',
      handleLoad,
    )

    trackedImages.forEach(
      (image) => {
        image.removeEventListener(
          'load',
          sendHeight,
        )

        image.removeEventListener(
          'error',
          sendHeight,
        )
      },
    )

    timeoutIds.forEach((id) => {
      window.clearTimeout(id)
    })

    if (
      animationFrame !== null
    ) {
      cancelAnimationFrame(
        animationFrame,
      )
    }
  }
}