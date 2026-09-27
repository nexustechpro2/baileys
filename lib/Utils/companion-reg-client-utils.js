export const CompanionWebClientType = Object.freeze({ UNKNOWN: 0, CHROME: 1, EDGE: 2, FIREFOX: 3, IE: 4, OPERA: 5, SAFARI: 6, ELECTRON: 7, UWP: 8, OTHER_WEB_CLIENT: 9 })

const BROWSER_TO_COMPANION = {
    Chrome: CompanionWebClientType.CHROME,
    Edge: CompanionWebClientType.EDGE,
    Firefox: CompanionWebClientType.FIREFOX,
    IE: CompanionWebClientType.IE,
    Opera: CompanionWebClientType.OPERA,
    Safari: CompanionWebClientType.SAFARI
}

export const getCompanionWebClientType = ([os, browserName]) => {
    if (browserName === 'Desktop') return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
    return BROWSER_TO_COMPANION[browserName] ?? CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = browser => getCompanionWebClientType(browser).toString()

export const buildPairingQRData = (ref, noiseKeyB64, identityKeyB64, advB64, browser) =>
    'https://wa.me/settings/linked_devices#' + [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(',')