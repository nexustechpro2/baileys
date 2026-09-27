import { proto } from '../../WAProto/index.js'

// Derived from proto.CollectionName — sorted by enum value, lowercased, UNKNOWN (0) excluded.
// Automatically picks up new collection names when the proto updates.
export const ALL_WA_PATCH_NAMES = Object.entries(proto.CollectionName ?? {})
    .filter(([k, v]) => typeof v === 'number' && v !== 0)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k.toLowerCase())