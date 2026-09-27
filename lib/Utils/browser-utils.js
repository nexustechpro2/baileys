import { platform, release } from 'os'
import { proto } from '../../WAProto/index.js'

const PLATFORM_MAP = {
    aix: 'AIX', darwin: 'Mac OS', win32: 'Windows', android: 'Android',
    freebsd: 'FreeBSD', openbsd: 'OpenBSD', sunos: 'Solaris',
    linux: undefined, haiku: undefined, cygwin: undefined, netbsd: undefined
}

export const Browsers = {
    ubuntu: browser => ['Ubuntu', browser, '24.04.2'],
    macOS: browser => ['Mac OS', browser, '15.4.1'],
    baileys: browser => ['Baileys', browser, '6.5.0'],
    windows: browser => ['Windows', browser, '10.0.26100'],
    android: browser => [browser, 'Android', ''],
    appropriate: browser => [PLATFORM_MAP[platform()] || 'Ubuntu', browser, release()]
}

export const getPlatformId = browser => {
    const upper = browser.toUpperCase()
    if (upper === 'ANDROID') return proto.DeviceProps.PlatformType.ANDROID_PHONE.toString()
    const type = proto.DeviceProps.PlatformType[upper]
    return (type ?? proto.DeviceProps.PlatformType.CHROME).toString()
}

export const isAndroidBrowser = browser => browser[1]?.toUpperCase() === 'ANDROID'