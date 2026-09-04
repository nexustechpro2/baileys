import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const acorn = require('acorn')
const walk = require('acorn-walk')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTO_FILE = join(__dirname, 'WAProto.proto')

const addPrefix = (lines, prefix) => lines.map(l => prefix + l)

function extractAllExpressions(node) {
    const out = [node]
    const exp = node.expression
    if (exp) out.push(exp)
    if (node?.expression?.arguments?.length)
        for (const arg of node.expression.arguments)
            if (arg?.body?.body?.length)
                for (const e of arg.body.body) out.push(...extractAllExpressions(e))
    if (node?.body?.body?.length)
        for (const e of node.body.body)
            if (e.expression) out.push(...extractAllExpressions(e.expression))
    if (node.expression?.expressions?.length)
        for (const e of node.expression.expressions) out.push(...extractAllExpressions(e))
    return out
}

function getNumericEnumValue(node) {
    if (node?.type === 'Literal' && typeof node.value === 'number') return node.value
    if (node?.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+') &&
        node.argument?.type === 'Literal' && typeof node.argument.value === 'number')
        return node.operator === '-' ? -node.argument.value : node.argument.value
    return undefined
}

function parseBundleSources(sources) {
    return sources.flatMap((source, idx) => {
        const patched = source.replaceAll('LimitSharing$Trigger', 'LimitSharing$TriggerType')
        const opts = { ecmaVersion: 'latest', allowHashBang: true }
        try { return acorn.parse(patched, { ...opts, sourceType: 'script' }).body }
        catch {
            try { return acorn.parse(patched, { ...opts, sourceType: 'module' }).body }
            catch (e) { process.stderr.write(`[WAProto] Skipping bundle ${idx + 1}: ${e.message}\n`); return [] }
        }
    })
}

function filterProtoModules(allNodes) {
    return allNodes.filter(m => {
        const expressions = extractAllExpressions(m)
        return expressions.find(e => e?.left?.property?.name === 'internalSpec')
    })
}

export function extractSchema(bundleSources) {
    const allNodes = parseBundleSources(Array.isArray(bundleSources) ? bundleSources : [bundleSources])
    const modules = filterProtoModules(allNodes)

    const unspecName = n => n.endsWith('Spec') ? n.slice(0, -4) : n
    const getNesting = n => n.split('$').slice(0, -1).join('$')
    const rename = n => unspecName(n)

    const modulesInfo = {}
    const moduleIndentationMap = {}

    // pass 1: cross-refs
    modules.forEach(module => {
        const modName = module?.expression?.arguments?.[0]?.value ?? `__anon_${Math.random()}`
        modulesInfo[modName] = { crossRefs: [] }
        walk.simple(module, {
            AssignmentExpression(node) {
                if (node?.right?.type === 'CallExpression' &&
                    node?.right?.arguments?.length === 1 &&
                    node?.right?.arguments[0]?.type !== 'ObjectExpression')
                    modulesInfo[modName].crossRefs.push({ alias: node.left?.name, module: node.right.arguments[0].value })
            },
        })
    })

    // pass 2: identifiers + enum aliases
    for (const mod of modules) {
        const modName = mod?.expression?.arguments?.[0]?.value
        const modInfo = modulesInfo[modName]
        const assignments = []

        walk.simple(mod, {
            AssignmentExpression(node) {
                const left = node.left
                if (left?.property?.name &&
                    left.property.name !== 'internalSpec' &&
                    left.property.name !== 'internalDefaults' &&
                    left.property.name !== 'name') assignments.push(left)
            },
        })

        const makeBlankIdent = a => {
            const key = rename(a?.property?.name)
            const indentation = getNesting(key)
            moduleIndentationMap[key] = moduleIndentationMap[key] || {}
            moduleIndentationMap[key].indentation = indentation
            if (indentation.length) {
                moduleIndentationMap[indentation] = moduleIndentationMap[indentation] || {}
                moduleIndentationMap[indentation].members = moduleIndentationMap[indentation].members || new Set()
                moduleIndentationMap[indentation].members.add(key)
            }
            return [key, { name: key }]
        }

        modInfo.identifiers = Object.fromEntries(assignments.map(makeBlankIdent).reverse())

        const enumAliases = {}
        walk.ancestor(mod, {
            Property(node, anc) {
                const fatherNode = anc[anc.length - 3]
                const fatherFather = anc[anc.length - 4]
                if (fatherNode?.type === 'AssignmentExpression' &&
                    fatherNode?.left?.property?.name === 'internalSpec' &&
                    fatherNode?.right?.properties?.length) {
                    const values = fatherNode.right.properties.map(p => ({ name: p.key.name, id: p.value.value }))
                    enumAliases[fatherNode?.left?.name] = values
                } else if (fatherNode?.type === 'VariableDeclarator' &&
                    fatherNode?.init?.type === 'ObjectExpression' &&
                    fatherNode.init.properties.length &&
                    fatherNode.init.properties.every(p => getNumericEnumValue(p.value) !== undefined)) {
                    const values = fatherNode.init.properties.map(p => ({ name: p.key.name || p.key.value, id: getNumericEnumValue(p.value) }))
                    enumAliases[fatherNode.id?.name] = values
                } else if (node?.key?.name && fatherNode?.arguments?.length > 0) {
                    const values = fatherNode.arguments?.[0]?.properties?.map(p => ({ name: p.key.name, id: p.value.value }))
                    const nameAlias = fatherFather?.left?.name || fatherFather?.id?.name
                    if (nameAlias) enumAliases[nameAlias] = values
                }
            },
        })

        walk.simple(mod, {
            AssignmentExpression(node) {
                if (node.left?.type === 'MemberExpression' && modInfo.identifiers?.[rename(node.left.property?.name)]) {
                    const ident = modInfo.identifiers[rename(node.left.property.name)]
                    ident.alias = node.right?.name
                    ident.enumValues = enumAliases[ident.alias]
                }
            },
        })
    }

    // pass 3: internalSpec members
    const findByAlias = (identifiers, alias) => Object.values(identifiers).find(item => item.alias === alias)

    for (const mod of modules) {
        const modName = mod?.expression?.arguments?.[0]?.value
        const modInfo = modulesInfo[modName]

        walk.simple(mod, {
            AssignmentExpression(node) {
                if (node.left?.type !== 'MemberExpression' ||
                    node.left.property?.name !== 'internalSpec' ||
                    node.right?.type !== 'ObjectExpression') return

                const targetIdent = Object.values(modInfo.identifiers).find(v => v.alias === node.left.object?.name)
                if (!targetIdent) return

                const constraints = [], rawMembers = []
                for (const p of node.right.properties) {
                    p.key.name = p.key.type === 'Identifier' ? p.key.name : p.key.value
                        ; (p.key.name.substring(0, 2) === '__' ? constraints : rawMembers).push(p)
                }

                let members = rawMembers.map(({ key: { name }, value: { elements } }) => {
                    let type
                    const flags = []
                    const unwrapBinaryOr = n =>
                        n.type === 'BinaryExpression' && n.operator === '|'
                            ? [].concat(unwrapBinaryOr(n.left), unwrapBinaryOr(n.right))
                            : [n]

                    unwrapBinaryOr(elements[1]).forEach(m => {
                        if (m.type !== 'MemberExpression' || m.object?.type !== 'MemberExpression') return
                        if (m.object.property?.name === 'TYPES') {
                            type = m.property.name.toLowerCase()
                            if (type === 'map' && elements[2]?.type === 'ArrayExpression') {
                                let typeStr = 'map<'
                                elements[2].elements.forEach((el, i) => {
                                    typeStr += el?.property?.name
                                        ? el.property.name.toLowerCase()
                                        : (findByAlias(modInfo.identifiers, el.name)?.name ?? el.name)
                                    if (i < elements[2].elements.length - 1) typeStr += ', '
                                })
                                type = typeStr + '>'
                            }
                        } else if (m.object.property?.name === 'FLAGS') {
                            flags.push(m.property.name.toLowerCase())
                        }
                    })

                    if (type === 'message' || type === 'enum') {
                        if (elements[2]?.type === 'Identifier') {
                            const found = Object.values(modInfo.identifiers).find(v => v.alias === elements[2].name)
                            type = found?.name
                        } else if (elements[2]?.type === 'MemberExpression') {
                            const targetAlias = elements[2]?.object?.name || elements[2]?.object?.left?.name || elements[2]?.object?.callee?.name
                            const crossRef = modInfo.crossRefs.find(r => r.alias === targetAlias)
                            if (elements[1]?.property?.name === 'ENUM' && elements[2]?.property?.name?.includes('Type'))
                                type = rename(elements[2].property.name)
                            else if (elements[2]?.property?.name?.includes('Spec'))
                                type = rename(elements[2].property.name)
                            else if (crossRef && crossRef.module !== '$InternalEnum' && modulesInfo[crossRef.module]?.identifiers?.[rename(elements[2].property.name)])
                                type = rename(elements[2].property.name)
                        }
                    }

                    return { name, id: elements[0].value, type, flags }
                })

                constraints.forEach(c => {
                    if (c.key.name === '__oneofs__' && c.value.type === 'ObjectExpression') {
                        const oneofs = c.value.properties.map(p => ({
                            name: p.key.name,
                            type: '__oneof__',
                            members: p.value.elements.map(e => {
                                const idx = members.findIndex(m => m.name === e.value)
                                const member = members[idx]
                                members.splice(idx, 1)
                                return member
                            }),
                        }))
                        members.push(...oneofs)
                    }
                })

                targetIdent.members = members
            },
        })
    }

    return { modulesInfo, moduleIndentationMap }
}

export function generateProto3(modulesInfo, moduleIndentationMap, version) {
    const indent = '  '
    const unnest = n => n.split('$').slice(-1)[0]

    const stringifyMember = (info, completeFlags, parentName) => {
        if (info.type === '__oneof__') {
            return [`oneof ${info.name} {`, ...addPrefix([].concat(...info.members.map(m => stringifyMember(m, false))), indent), '}']
        }
        if (info.flags.includes('packed')) { info.flags.splice(info.flags.indexOf('packed'), 1); info.packed = ' [packed=true]' }
        const reqIdx = info.flags.indexOf('required'); if (reqIdx !== -1) info.flags[reqIdx] = 'optional'
        if (completeFlags && !info.flags.length && info.type && !info.type.includes('map')) info.flags.push('optional')

        const indentation = moduleIndentationMap[info.type]?.indentation
        let typeName = unnest(info.type || 'bytes')
        if (indentation !== parentName && indentation) typeName = `${indentation.replaceAll('$', '.')}.${typeName}`

        return [`${info.flags.join(' ')}${info.flags.length ? ' ' : ''}${typeName} ${info.name} = ${info.id}${info.packed || ''};`]
    }

    const decodedProtoMap = {}

    for (const [, modInfo] of Object.entries(modulesInfo)) {
        if (!modInfo.identifiers) continue

        const stringifyEnum = (ident, overrideName = null) => [
            `enum ${overrideName || ident.displayName || ident.name} {`,
            ...addPrefix(ident.enumValues.map(v => `${v.name} = ${v.id};`), indent),
            '}',
        ]

        function stringifyMessage(ident) {
            const nestedKeys = moduleIndentationMap[ident.name]?.members
            const result = [
                `message ${ident.displayName || ident.name} {`,
                ...addPrefix([].concat(...ident.members.map(m => stringifyMember(m, true, ident.name))), indent),
            ]
            if (nestedKeys?.size) {
                for (const memberName of Array.from(nestedKeys).sort()) {
                    let entity = modInfo.identifiers[memberName]
                    if (entity) {
                        entity = { ...entity, displayName: entity.name.slice(ident.name.length + 1) }
                        result.push(...addPrefix(getEntity(entity), indent))
                    }
                }
            }
            result.push('}', '')
            return result
        }

        const getEntity = v => {
            if (v.members) return stringifyMessage(v)
            if (v.enumValues?.length) return stringifyEnum(v)
            return [`// Unknown entity ${v.name}`]
        }

        for (const v of Object.values(modInfo.identifiers)) {
            if (!moduleIndentationMap[v.name]?.indentation?.length)
                decodedProtoMap[v.name] = getEntity(v).join('\n')
        }
    }

    const body = Object.keys(decodedProtoMap).sort().map(k => decodedProtoMap[k]).join('\n')
    return `syntax = "proto3";\npackage proto;\n${version ? `\n/// WhatsApp Version: ${version}\n` : ''}\n${body}`
}

export async function parseAndWriteProto(bundle, version) {
    const sources = Array.isArray(bundle) ? bundle : [bundle]
    const { modulesInfo, moduleIndentationMap } = extractSchema(sources)
    const protoText = generateProto3(modulesInfo, moduleIndentationMap, version)
    const unknown = [...protoText.matchAll(/\/\/ Unknown entity (.+)/g)].map(m => m[1])
    writeFileSync(PROTO_FILE, protoText, 'utf8')
    return {
        messageCount: Object.values(modulesInfo).reduce((s, m) => s + Object.keys(m.identifiers || {}).length, 0),
        unknownCount: unknown.length,
    }
}