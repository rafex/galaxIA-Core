/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Ciclo de misión P2P del Navigator (DEC-P2P-001, DEC-0088).
 * Publish offer → collect bids → select best → publish assign.
 * Devuelve el bid ganador para que el Navigator abra el stream directo.
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import {
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_ASSIGN,
  type MissionType,
} from "./fhs-p2p-types.js";
import type { FhsNode, FhsIdentity, BidCollector } from "./nav-node.js";
import { pubsubPublish } from "./nav-node.js";
import { missionAssignCodec, missionOfferCodec } from "./p2p-wire.js";

export interface MissionCycleOptions {
  node: FhsNode;
  identity: FhsIdentity;
  collector: BidCollector;
  missionType: MissionType;
  requiredCapabilities: string[];
  preferredModel?: string;
  bidDeadlineMs?: number;
}

export interface WinningBid {
  missionId: string;
  bid: FhsProto.MissionBidMessage;
}

/**
 * Ejecuta el ciclo completo offer→bid→assign.
 * Devuelve null si no hay bids o ninguno es válido.
 */
export async function runMissionCycle(
  opts: MissionCycleOptions
): Promise<WinningBid | null> {
  const {
    node,
    identity,
    collector,
    missionType,
    requiredCapabilities,
    preferredModel,
    bidDeadlineMs = 2_000,
  } = opts;

  const missionId = randomUUID();

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  // Publicar offer
  const offer = create(FhsProto.MissionOfferMessageSchema, {
    missionId,
    navigatorDid: identity.did,
    navigatorMultiaddrs: multiaddrs(),
    missionType,
    requiredCapabilities,
    preferredModel: preferredModel ?? "",
    bidDeadlineMs: BigInt(bidDeadlineMs),
    timestamp: BigInt(Date.now()),
    signature: new Uint8Array(0),
  });
  pubsubPublish(node, TOPIC_MISSIONS_OFFER, offer, missionOfferCodec);
  console.log(`[mission] offer ${missionId} publicado (type=${missionType})`);

  // Esperar bids por bidDeadlineMs
  const bids = await collector.open(missionId, bidDeadlineMs);
  console.log(`[mission] ${bids.length} bid(s) recibidos para ${missionId}`);

  if (bids.length === 0) return null;

  // Seleccionar mejor bid: trustLevel → reputationScore → estimatedLatencyMs
  const TRUST_RANK: Record<string, number> = {
    delegated: 4,
    standard: 3,
    community: 2,
    unverified: 1,
  };

  const best = bids.sort((a, b) => {
    const ta = TRUST_RANK[a.trustLevel] ?? 0;
    const tb = TRUST_RANK[b.trustLevel] ?? 0;
    if (ta !== tb) return tb - ta;
    if (a.reputationScore !== b.reputationScore) return b.reputationScore - a.reputationScore;
    return a.estimatedLatencyMs - b.estimatedLatencyMs;
  })[0];

  // Publicar assign
  const assign = create(FhsProto.MissionAssignMessageSchema, {
    missionId,
    navigatorDid: identity.did,
    assignedProvider: best.providerDid,
    timestamp: BigInt(Date.now()),
    signature: new Uint8Array(0),
  });
  pubsubPublish(node, TOPIC_MISSIONS_ASSIGN, assign, missionAssignCodec);
  console.log(
    `[mission] assign ${missionId} → ${best.providerDid} (${best.providerMultiaddrs[0] ?? "?"})`
  );

  return { missionId, bid: best };
}
