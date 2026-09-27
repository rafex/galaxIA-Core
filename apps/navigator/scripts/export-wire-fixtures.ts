/**
 * Fixtures dorados del wire FHS generados por la implementación TS de
 * producción (p2p-wire: codecs firmados, sealEnvelope, encodeEnvelopeFrame).
 *
 * Sirven para que otra implementación (galaxIA-agent en Rust) demuestre que
 * decodifica, re-codifica byte a byte y verifica las mismas firmas antes de
 * hablar con la red real. Determinista: llave de semilla fija y tiempos fijos.
 *
 * Uso: npx tsx scripts/export-wire-fixtures.ts <salida.json>
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";
import {
  FhsProto,
  encodeEnvelopeFrame,
  encodeMessage,
  envelopeSignaturePayload,
  missionAssignSignaturePayload,
  missionBidSignaturePayload,
  missionOfferSignaturePayload,
  nodeAdvertiseSignaturePayload,
} from "@rafex/galaxia-fhs-protocol";
import {
  configureSigner,
  dynamicValueFromUnknown,
  envelopePayloadBytes,
  makeChatRequestEnvelope,
  makeHandshakeEnvelope,
  makeNavigatorBeacon,
  makeToolCallEnvelope,
  missionAssignCodec,
  missionBidCodec,
  missionOfferCodec,
  nodeAdvertiseCodec,
  sealEnvelope,
} from "../src/p2p/p2p-wire.js";

const out = process.argv[2];
if (!out) throw new Error("uso: export-wire-fixtures.ts <salida.json>");

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const TS = 1_790_000_000_000; // fijo: los fixtures deben ser reproducibles
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const privateKey = await generateKeyPairFromSeed("Ed25519", seed);
const publicKeyRaw = (privateKey.publicKey as { raw: Uint8Array }).raw;
const did = `did:key:z${base58btc.baseEncode(Uint8Array.from([0xed, 0x01, ...publicKeyRaw]))}`;
configureSigner(did, privateKey);

// ── Mensajes GossipSub firmados ───────────────────────────────────────────────
const kbBeacon = create(FhsProto.BeaconSchema, {
  fhsVersion: "0.1",
  provider: create(FhsProto.ProviderIdentitySchema, {
    id: did,
    type: FhsProto.ProviderType.SATELLITE,
    visibility: FhsProto.Visibility.COMMUNITY,
    name: "KB Provider FHS",
    description: "Constitución Política: educación, derechos humanos",
    tags: ["tool:kb_query"],
  }),
  capabilities: [create(FhsProto.CapabilityDescriptorSchema, { id: "knowledge.query" })],
});

const signed = [
  {
    name: "node_advertise_navigator",
    type: "NodeAdvertiseMessage",
    message: create(FhsProto.NodeAdvertiseMessageSchema, {
      did, beacon: makeNavigatorBeacon(), multiaddrs: ["/ip4/192.168.1.139/tcp/4010/tls/ws"],
      timestamp: BigInt(TS), ttlSeconds: 60, trustLevel: "community",
    }),
    encode: (m: FhsProto.NodeAdvertiseMessage) => nodeAdvertiseCodec.encode(m),
    payload: (m: FhsProto.NodeAdvertiseMessage) => nodeAdvertiseSignaturePayload(
      m.did, sha256(encodeMessage(FhsProto.BeaconSchema, m.beacon!)), Number(m.timestamp), m.ttlSeconds),
    beacon: (m: FhsProto.NodeAdvertiseMessage) => m.beacon!,
  },
  {
    name: "node_advertise_kb",
    type: "NodeAdvertiseMessage",
    message: create(FhsProto.NodeAdvertiseMessageSchema, {
      did, beacon: kbBeacon, multiaddrs: ["/ip4/127.0.0.1/tcp/4006/tls/ws", "/ip4/192.168.1.181/tcp/4006/tls/ws"],
      timestamp: BigInt(TS), ttlSeconds: 60, trustLevel: "community",
    }),
    encode: (m: FhsProto.NodeAdvertiseMessage) => nodeAdvertiseCodec.encode(m),
    payload: (m: FhsProto.NodeAdvertiseMessage) => nodeAdvertiseSignaturePayload(
      m.did, sha256(encodeMessage(FhsProto.BeaconSchema, m.beacon!)), Number(m.timestamp), m.ttlSeconds),
    beacon: (m: FhsProto.NodeAdvertiseMessage) => m.beacon!,
  },
  {
    name: "mission_offer",
    type: "MissionOfferMessage",
    message: create(FhsProto.MissionOfferMessageSchema, {
      missionId: "11111111-1111-4111-8111-111111111111", navigatorDid: did,
      navigatorMultiaddrs: ["/ip4/192.168.1.139/tcp/4010/tls/ws"], missionType: "tool_call",
      requiredCapabilities: ["knowledge.query"], preferredModel: "", bidDeadlineMs: 2000n, timestamp: BigInt(TS),
    }),
    encode: (m: FhsProto.MissionOfferMessage) => missionOfferCodec.encode(m),
    payload: (m: FhsProto.MissionOfferMessage) => missionOfferSignaturePayload(
      m.missionId, m.navigatorDid, m.missionType, Number(m.bidDeadlineMs), Number(m.timestamp)),
  },
  {
    name: "mission_bid",
    type: "MissionBidMessage",
    message: create(FhsProto.MissionBidMessageSchema, {
      missionId: "11111111-1111-4111-8111-111111111111", providerDid: did,
      providerMultiaddrs: ["/ip4/192.168.1.181/tcp/4006/tls/ws"],
      offeredCapabilities: ["knowledge.query", "document.query"], trustLevel: "community",
      reputationScore: 0.5, estimatedLatencyMs: 120, timestamp: BigInt(TS + 5),
    }),
    encode: (m: FhsProto.MissionBidMessage) => missionBidCodec.encode(m),
    payload: (m: FhsProto.MissionBidMessage) => missionBidSignaturePayload(
      m.missionId, m.providerDid, m.offeredCapabilities, Number(m.timestamp)),
  },
  {
    name: "mission_assign",
    type: "MissionAssignMessage",
    message: create(FhsProto.MissionAssignMessageSchema, {
      missionId: "11111111-1111-4111-8111-111111111111", navigatorDid: did, assignedProvider: did,
      timestamp: BigInt(TS + 10),
    }),
    encode: (m: FhsProto.MissionAssignMessage) => missionAssignCodec.encode(m),
    payload: (m: FhsProto.MissionAssignMessage) => missionAssignSignaturePayload(
      m.missionId, m.navigatorDid, m.assignedProvider, Number(m.timestamp)),
  },
];

const gossip = signed.map((entry) => {
  const message = entry.message as never;
  const bytes = entry.encode(message);
  const result: Record<string, string> = {
    name: entry.name,
    type: entry.type,
    bytes_hex: hex(bytes),
    signature_payload: entry.payload(message),
  };
  if ("beacon" in entry && entry.beacon) {
    result.beacon_sha256 = sha256(encodeMessage(FhsProto.BeaconSchema, entry.beacon(message)));
  }
  return result;
});

// ── Envelopes firmados (stream directo /fhs/v1/0.1.0) ─────────────────────────
function fixed(envelope: FhsProto.Envelope, messageId: string, destPeerId = ""): FhsProto.Envelope {
  return create(FhsProto.EnvelopeSchema, { ...envelope, messageId, destPeerId, timestamp: BigInt(TS) });
}

const envelopes = [
  ["envelope_handshake", fixed(makeHandshakeEnvelope(did, ["/ip4/192.168.1.139/tcp/4010/tls/ws"]), "msg-handshake")],
  ["envelope_chat_request", fixed(makeChatRequestEnvelope(did, "22222222-2222-4222-8222-222222222222", {
    model: "qwen2.5-3b-instruct-q4_k_m",
    messages: [
      { role: "system", content: "Responde en español." },
      { role: "user", content: "¿Qué dice el artículo 3 sobre la educación?" },
    ],
    tools: [{ type: "function", function: { name: "kb_query", description: "Consulta la KB", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }],
  }), "msg-chat", "did:key:star")],
  ["envelope_chat_delta", fixed(create(FhsProto.EnvelopeSchema, {
    sourcePeerId: did,
    payload: { case: "chatDelta", value: create(FhsProto.ChatDeltaMessageSchema, { missionId: "22222222-2222-4222-8222-222222222222", delta: "Toda persona tiene derecho a la educación." }) },
  }), "msg-delta")],
  // Argumentos con varias claves: DynamicObject es un `map`; otra
  // implementación debe verificar sobre los bytes crudos, no re-codificando.
  ["envelope_tool_call", fixed(makeToolCallEnvelope(did, "33333333-3333-4333-8333-333333333333", "kb_query", {
    query: "¿Qué dice el artículo 3 sobre la educación?",
    top_k: 3,
    conversationId: "conv-1",
    documentId: "",
  }), "msg-tool-call", "did:key:kb"), true],
].map(([name, envelope, containsMultiKeyMap]) => {
  const sealed = sealEnvelope(envelope as FhsProto.Envelope);
  const payloadHex = hex(envelopePayloadBytes(sealed.payload));
  return {
    name,
    payload_case: sealed.payload.case,
    contains_multi_key_map: Boolean(containsMultiKeyMap),
    envelope_hex: hex(encodeMessage(FhsProto.EnvelopeSchema, sealed)),
    frame_hex: hex(encodeEnvelopeFrame(sealed)),
    payload_hex: payloadHex,
    signature_payload: envelopeSignaturePayload(sealed.messageId, sealed.sourcePeerId, sealed.destPeerId, Number(sealed.timestamp), payloadHex),
  };
});

// ── DynamicValue ──────────────────────────────────────────────────────────────
const dynamicValues = [
  { name: "kb_chunks", json: [{ text: "Artículo 3. Toda persona tiene derecho a la educación.", score: 0.5 }] },
  { name: "scalars", json: { entero: 3, decimal: 0.25, texto: "sí", booleano: true, lista: [1, "dos"] } },
].map((entry) => ({ ...entry, bytes_hex: hex(encodeMessage(FhsProto.DynamicValueSchema, dynamicValueFromUnknown(entry.json))) }));

const fixtures = {
  generated_by: "galaxIA-Core/apps/navigator/scripts/export-wire-fixtures.ts",
  note: "Firmas Ed25519 sobre UTF-8 de signature_payload. beacon_sha256 y payload_hex son sobre la re-codificación Protobuf.",
  identity: {
    seed_hex: hex(seed),
    public_key_hex: hex(publicKeyRaw),
    did,
    peer_id: peerIdFromPrivateKey(privateKey).toString(),
  },
  gossip,
  envelopes,
  dynamic_values: dynamicValues,
};
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`fixtures: ${gossip.length} gossip, ${envelopes.length} envelopes, ${dynamicValues.length} dynamic values → ${out}`);
