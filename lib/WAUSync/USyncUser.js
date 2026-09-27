export class USyncUser {
    withId(id)                         { this.id = id; return this; }
    withLid(lid)                       { this.lid = lid; return this; }
    withPhone(phone)                   { this.phone = phone; return this; }
    withUsername(username)             { this.username = username; return this; }
    withUsernameKey(usernameKey)       { this.usernameKey = usernameKey; return this; }
    withType(type)                     { this.type = type; return this; }
    withPersonaId(personaId)           { this.personaId = personaId; return this; }
    withPictureId(pictureId)           { this.pictureId = pictureId; return this; }
    withTcToken(tcToken)               { this.tcToken = tcToken; return this; }
    withPnJid(pnJid)                   { this.pnJid = pnJid; return this; }
    withDeviceHash(deviceHash)         { this.deviceHash = deviceHash; return this; }
    withTs(ts)                         { this.ts = ts; return this; }
    withExpectedTs(expectedTs)         { this.expectedTs = expectedTs; return this; }
    withVerifiedNameSerial(serial)     { this.verifiedNameSerial = serial; return this; }
    withBusinessProfileTag(tag)        { this.businessProfileTag = tag; return this; }
    withSidelistDelete(del = true)     { this.sidelistDelete = del; return this; }
    // At least one addressable field required for a valid usync user
    validate() { return !!(this.id || this.phone || this.username || this.pnJid); }
}
