import { executeWMexQuery } from './mex.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeRegistrationSocket } from './registration.js'
import crypto from 'crypto'
import { USERNAME_QUERY_IDS, USERNAME_CHECK_RESULT, USERNAME_SOURCE } from '../Defaults/index.js'

export const makeUsernameSocket = config => {
    const sock = makeRegistrationSocket(config)
    const { query, generateMessageTag, executeUSyncQuery } = sock
    const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

    const checkUsername = async (username, includeSuggestions = true, sessionId) => {
        const session_id = sessionId || crypto.randomUUID()
        const data = await mexQuery({ username, include_suggestions: includeSuggestions, session_id, source: USERNAME_SOURCE.USER_INPUT }, USERNAME_QUERY_IDS.CHECK, 'xwa2_username_check')
        if (data?.includes?.(USERNAME_CHECK_RESULT.SUCCESS) || data?.result === USERNAME_CHECK_RESULT.SUCCESS) return { available: true, username, session_id }
        return { available: false, username, session_id, suggestions: data?.suggestions ?? [], rejectionReasons: data?.rejection_reasons ?? [], suggestionsEligible: data?.suggestions_eligible ?? true }
    }

    const setUsername = async (username, options = {}) => {
        const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options
        const session_id = sessionId || crypto.randomUUID()
        const variables = { username, reserved: true, source, session_id, ...(pin ? { pin } : {}) }
        return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set')
    }

    const checkAndSetUsername = async username => {
        const r = await checkUsername(username)
        if (r.available) return setUsername(username)
        return r
    }

    const deleteUsername = () => mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete')

    const getMyUsername = async () => {
        const data = await mexQuery({}, USERNAME_QUERY_IDS.GET, 'xwa2_username_get')
        return data?.username ?? null
    }

    const setUsernamePin = pin => {
        const variables = pin != null ? { pin } : {}
        return mexQuery(variables, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set')
    }

    const findUserByUsername = async (username, pin) => {
        const usyncQuery = new USyncQuery().withContactProtocol()
        const user = new USyncUser().withUsername(username)
        if (pin) user.withUsernameKey(pin)
        usyncQuery.withUser(user)
        const result = await executeUSyncQuery(usyncQuery)
        if (!result?.list?.length) return null
        const entry = result.list[0]
        return { jid: entry.id, contact: entry.contact ?? false }
    }

    const fetchContactUsernames = async (...jids) => {
        const usyncQuery = new USyncQuery().withUsernameProtocol()
        for (const jid of jids) usyncQuery.withUser(new USyncUser().withId(jid))
        const result = await executeUSyncQuery(usyncQuery)
        return result?.list ?? []
    }

    const checkUsernameMulti = usernames => mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi')

    const getUsernameRecommendations = (source = null) => {
        const variables = source ? { source } : {}
        return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations')
    }

    return {
        ...sock,
        checkUsername,
        checkUsernameMulti,
        setUsername,
        deleteUsername,
        getMyUsername,
        getUsernameRecommendations,
        setUsernamePin,
        findUserByUsername,
        fetchContactUsernames,
        checkAndSetUsername,
        USERNAME_QUERY_IDS,
        USERNAME_CHECK_RESULT,
        USERNAME_SOURCE
    }
}