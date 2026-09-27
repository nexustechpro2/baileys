export const makeMutex = () => {
    let task = Promise.resolve()
    return {
        mutex(code) {
            task = task.catch(() => { }).then(code)
            return task
        }
    }
}

export const makeKeyedMutex = () => {
    const map = {}
    return {
        mutex(key, code) { if (!map[key]) map[key] = makeMutex(); return map[key].mutex(code) }
    }
}