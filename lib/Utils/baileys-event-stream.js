import EventEmitter from 'events'
import { createReadStream } from 'fs'
import { writeFile } from 'fs/promises'
import { createInterface } from 'readline'
import { delay } from './generics.js'
import { makeMutex } from './make-mutex.js'

export const captureEventStream = (ev, filename) => {
    const oldEmit = ev.emit.bind(ev)
    const writeMutex = makeMutex()
    ev.emit = (...args) => {
        const content = JSON.stringify({ timestamp: Date.now(), event: args[0], data: args[1] }) + '\n'
        const result = oldEmit(...args)
        writeMutex.mutex(() => writeFile(filename, content, { flag: 'a' }))
        return result
    }
}

export const readAndEmitEventStream = (filename, delayIntervalMs = 0) => {
    const ev = new EventEmitter()
    const fireEvents = async () => {
        const fileStream = createReadStream(filename)
        const rl = createInterface({ input: fileStream, crlfDelay: Infinity })
        for await (const line of rl) {
            if (!line) continue
            const { event, data } = JSON.parse(line)
            ev.emit(event, data)
            if (delayIntervalMs) await delay(delayIntervalMs)
        }
        fileStream.destroy()
    }
    return { ev, task: fireEvents() }
}