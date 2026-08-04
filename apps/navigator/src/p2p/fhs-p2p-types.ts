/**
 * Constantes de topics P2P. Los mensajes ya no se definen localmente: sus
 * tipos y schemas viven en @rafex/galaxia-fhs-protocol/FhsProto.
 */
export {
  FHS_STREAM_PROTOCOL,
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  TOPIC_REPUTATION_UPDATE,
} from "@rafex/galaxia-fhs-protocol";

export type MissionType = "chat" | "tool_call" | "agent";
