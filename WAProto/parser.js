import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_FILE = join(__dirname, 'WAProto.proto')

const PROTO3_SCALAR = {
    'TYPES.FLOAT': 'float',
    'TYPES.DOUBLE': 'double',
    'TYPES.INT32': 'int32',
    'TYPES.INT64': 'int64',
    'TYPES.UINT32': 'uint32',
    'TYPES.UINT64': 'uint64',
    'TYPES.SINT32': 'sint32',
    'TYPES.SINT64': 'sint64',
    'TYPES.FIXED32': 'fixed32',
    'TYPES.FIXED64': 'fixed64',
    'TYPES.SFIXED32': 'sfixed32',
    'TYPES.SFIXED64': 'sfixed64',
    'TYPES.BOOL': 'bool',
    'TYPES.STRING': 'string',
    'TYPES.BYTES': 'bytes',
    'TYPES.MESSAGE': 'message',
    'TYPES.ENUM': 'enum',
}

function extractModules(bundle) {
    const starts = []
    const headerRe = /__d\("([^"]+)",\s*(\[[^\]]*\]),\s*\(function\(([^)]*)\)/g
    let m
    while ((m = headerRe.exec(bundle)) !== null) {
        starts.push({
            name: m[1],
            params: m[3].split(',').map(p => p.trim()),
            bodyStart: m.index,
        })
    }

    const modules = []
    for (let i = 0; i < starts.length; i++) {
        const mod = starts[i]
        const bodyEnd = i + 1 < starts.length ? starts[i + 1].bodyStart : bundle.length
        const body = bundle.slice(mod.bodyStart, bodyEnd)
        if (!body.includes('internalSpec') || mod.name === 'WAProtoCompile') continue
        modules.push({ name: mod.name, params: mod.params, body })
    }

    return modules
}

function extractEnums(body, params) {
    const requireParam = params[1] || 'n'
    const enums = new Map()

    const patternC = new RegExp(
        String.raw`([a-zA-Z_$][\w$]*)\s*=\s*\(\s*([a-zA-Z_$][\w$]*)\s*=\s*${requireParam}\(["']\$InternalEnum["']\)\s*\)\s*\(\s*\{([^}]+)\}`,
        'g'
    )
    const factoryVarsC = new Set()
    let m
    while ((m = patternC.exec(body)) !== null) {
        factoryVarsC.add(m[2])
        enums.set(m[1], parseEnumValues(m[3]))
    }

    const patternA = new RegExp(
        String.raw`([a-zA-Z_$][\w$]*)\s*=\s*${requireParam}\(["']\$InternalEnum["']\)\s*\(\s*\{([^}]+)\}`,
        'g'
    )
    while ((m = patternA.exec(body)) !== null) {
        enums.set(m[1], parseEnumValues(m[2]))
    }

    const patternBBind = new RegExp(
        String.raw`([a-zA-Z_$][\w$]*)\s*=\s*${requireParam}\(["']\$InternalEnum["']\)(?!\s*\()`,
        'g'
    )
    while ((m = patternBBind.exec(body)) !== null) {
        const factoryVar = m[1]
        if (factoryVarsC.has(factoryVar)) continue
        const callRe = new RegExp(String.raw`([a-zA-Z_$][\w$]*)\s*=\s*${factoryVar}\s*\(\s*\{([^}]+)\}`, 'g')
        let cm
        while ((cm = callRe.exec(body)) !== null) {
            if (cm[1] !== factoryVar) enums.set(cm[1], parseEnumValues(cm[2]))
        }
    }

    for (const factoryVar of factoryVarsC) {
        const callRe = new RegExp(String.raw`([a-zA-Z_$][\w$]*)\s*=\s*${factoryVar}\s*\(\s*\{([^}]+)\}`, 'g')
        let cm
        while ((cm = callRe.exec(body)) !== null) {
            if (!enums.has(cm[1])) enums.set(cm[1], parseEnumValues(cm[2]))
        }
    }

    return enums
}

function parseEnumValues(raw) {
    const values = {}
    const re = /([A-Z][A-Z0-9_]*)\s*:\s*(-?\d+)/g
    let m
    while ((m = re.exec(raw)) !== null) values[m[1]] = parseInt(m[2])
    return values
}

function extractExportMap(body, params) {
    const exportParam = params[6] || 'l'
    const map = new Map()
    const re = new RegExp(
        String.raw`${exportParam}\.([A-Z][a-zA-Z0-9_$]*(?:\$[A-Z][a-zA-Z0-9_$]*)*)\s*=\s*([a-zA-Z_$][\w$]*)`,
        'g'
    )
    let m
    while ((m = re.exec(body)) !== null) {
        const exported = m[1]
        const canonical = exported.endsWith('Spec') ? exported.slice(0, -4) : exported
        map.set(m[2], canonical)
    }
    return map
}

function extractMessages(body) {
    const messages = new Map()
    const re = /([a-zA-Z_$][\w$]*)\.name\s*=\s*"([^"]+)"/g
    let m
    while ((m = re.exec(body)) !== null) {
        messages.set(m[1], { canonicalName: m[2], fields: new Map() })
    }
    return messages
}

function parseFields(specBody, messages, enums, exportMap, requireParam) {
    const fields = new Map()
    const fieldRe = /([a-zA-Z_$][\w$]*)\s*:\s*\[(\d+)\s*,\s*([^\]]+)\]/g
    let m

    while ((m = fieldRe.exec(specBody)) !== null) {
        const fieldName = m[1]
        const fieldId = parseInt(m[2])
        const rest = m[3].trim()
        const isRepeated = rest.includes('REPEATED')

        let scalarType = 'bytes'
        for (const [key, val] of Object.entries(PROTO3_SCALAR)) {
            if (rest.includes(key)) { scalarType = val; break }
        }

        let refCanonical = null

        if (scalarType === 'message' || scalarType === 'enum') {
            const crossRe = new RegExp(String.raw`${requireParam}\(["']([^"']+)["']\)\.([\w$]+)`, 'g')
            let crossMatch = null
            let cm
            while ((cm = crossRe.exec(rest)) !== null) {
                if (cm[1] !== 'WAProtoConst') { crossMatch = cm; break }
            }

            if (crossMatch) {
                const name = crossMatch[2]
                refCanonical = name.endsWith('Spec') ? name.slice(0, -4) : name
            } else {
                const tokens = rest.split(',').map(t => t.trim())
                const refToken = tokens[tokens.length - 1]
                if (/^[a-zA-Z_$][\w$]*$/.test(refToken)) {
                    if (messages.has(refToken)) {
                        refCanonical = messages.get(refToken).canonicalName
                    } else if (enums.has(refToken)) {
                        refCanonical = exportMap.get(refToken) || refToken
                    }
                }
            }
        }

        fields.set(fieldName, { id: fieldId, type: scalarType, repeated: isRepeated, ref: refCanonical })
    }

    return fields
}

function extractSpecs(body, messages, enums, exportMap, params) {
    const requireParam = params[3] || 'o'
    const specRe = /([a-zA-Z_$][\w$]*)\.internalSpec\s*=\s*\{/g
    let m

    while ((m = specRe.exec(body)) !== null) {
        const varName = m[1]
        if (!messages.has(varName)) continue

        let depth = 1
        let pos = m.index + m[0].length
        while (pos < body.length && depth > 0) {
            if (body[pos] === '{') depth++
            else if (body[pos] === '}') depth--
            pos++
        }

        const specBody = body.slice(m.index + m[0].length, pos - 1)
        messages.get(varName).fields = parseFields(specBody, messages, enums, exportMap, requireParam)
    }
}

function buildSchema(modules) {
    const allMessages = new Map()
    const allEnums = new Map()

    for (const { body, params } of modules) {
        const enums = extractEnums(body, params)
        const messages = extractMessages(body)
        const exportMap = extractExportMap(body, params)

        extractSpecs(body, messages, enums, exportMap, params)

        for (const [varName, values] of enums) {
            const canonical = exportMap.get(varName)
            if (canonical) allEnums.set(canonical, values)
        }

        for (const [, msg] of messages) {
            for (const field of msg.fields.values()) {
                if (field.type === 'enum' && field.ref && allEnums.has(field.ref)) {
                    field.ref = field.ref
                }
            }
            allMessages.set(msg.canonicalName, { fields: msg.fields })
        }
    }

    return { messages: allMessages, enums: allEnums }
}

function generateProto3(schema, version) {
    const { messages, enums } = schema
    const lines = [
        'syntax = "proto3";',
        'package proto;',
        ...(version ? [`/// WhatsApp Version: ${version}`] : []),
        '',
    ]
    const written = new Set()

    function directChildrenOf(parentName, source) {
        const prefix = parentName + '$'
        const depth = parentName.split('$').length + 1
        return [...source.keys()].filter(n => n.startsWith(prefix) && n.split('$').length === depth)
    }

    function writeEnum(name, indent) {
        if (written.has(name)) return
        written.add(name)
        const shortName = name.split('$').pop()
        const sorted = Object.entries(enums.get(name)).sort(([, a], [, b]) => a - b)
        lines.push(`${indent}enum ${shortName} {`)
        for (const [key, val] of sorted) lines.push(`${indent}  ${key} = ${val};`)
        lines.push(`${indent}}`, '')
    }

    function writeMessage(name, indent) {
        if (written.has(name)) return
        written.add(name)
        const shortName = name.split('$').pop()
        const msg = messages.get(name)
        lines.push(`${indent}message ${shortName} {`)
        for (const child of directChildrenOf(name, enums)) writeEnum(child, indent + '  ')
        for (const child of directChildrenOf(name, messages)) writeMessage(child, indent + '  ')
        if (msg?.fields.size > 0) {
            const sorted = [...msg.fields.entries()].sort(([, a], [, b]) => a.id - b.id)
            for (const [fieldName, field] of sorted) {
                const label = field.repeated ? 'repeated' : 'optional'
                const typeName = (field.type === 'message' || field.type === 'enum')
                    ? (field.ref ? field.ref.split('$').pop() : 'bytes')
                    : field.type
                lines.push(`${indent}  ${label} ${typeName} ${fieldName} = ${field.id};`)
            }
        }
        lines.push(`${indent}}`, '')
    }

    for (const name of [...enums.keys()].sort()) {
        if (!name.includes('$')) writeEnum(name, '')
    }
    for (const name of [...messages.keys()].sort()) {
        if (!name.includes('$')) writeMessage(name, '')
    }

    return lines.join('\n')
}

export async function parseAndWriteProto(bundle, version) {
    const modules = extractModules(bundle)
    if (modules.length === 0) throw new Error('[WAProto] No proto modules found in bundle')

    const schema = buildSchema(modules)
    const protoText = generateProto3(schema, version)
    writeFileSync(PROTO_FILE, protoText, 'utf8')

    return { schema, messageCount: schema.messages.size, enumCount: schema.enums.size }
}

export { buildSchema, extractModules }
