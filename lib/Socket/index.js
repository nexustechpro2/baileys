import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js'
import { makeMessageBuilderSocket } from './nexus-handler.js'

const makeWASocket = (config) => {
    const newConfig = { ...DEFAULT_CONNECTION_CONFIG, ...config }
    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
    }
    return makeMessageBuilderSocket(newConfig)
}

export * from './chats.js'
export * from './nexus-handler.js'
export { makeWASocket }
export default makeWASocket
