import { proto } from '../../WAProto/index.js';
// export the WAMessage Prototypes
export { proto as WAProto };
export const WAMessageStubType = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.StubType?.[k] });
export const WAMessageStatus = new Proxy({}, { get: (_, k) => proto.WebMessageInfo?.Status?.[k] });
export var WAMessageAddressingMode;
(function (WAMessageAddressingMode) {
    WAMessageAddressingMode["PN"] = "pn";
    WAMessageAddressingMode["LID"] = "lid";
})(WAMessageAddressingMode || (WAMessageAddressingMode = {}));
//# sourceMappingURL=Message.js.map