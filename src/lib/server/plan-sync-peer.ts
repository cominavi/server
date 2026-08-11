import * as Automerge from "@automerge/automerge";
import { base64URL } from "./auth-sessions";
import type { PlanDocument } from "./plan-document";
import { sendPlanSyncFrameIfAuthorized } from "./plan-sync-send-gate";

export interface PlanPeerSessionInput {
  document: Automerge.Doc<PlanDocument>;
  encodedSyncState: Uint8Array;
  nextServerSequence: number;
  planID: string;
  sessionID: string;
  frameID: string;
  hasAuthority(): Promise<boolean>;
  persist(encodedSyncState: Uint8Array, nextServerSequence: number): void;
  socket: {
    send(message: string): void;
    close(code: number, reason: string): void;
  };
}

export async function advancePlanPeerSession(
  input: PlanPeerSessionInput,
): Promise<"idle" | "sent" | "revoked"> {
  if (!(await input.hasAuthority())) {
    input.socket.close(4403, "membership_revoked");
    return "revoked";
  }
  const state = Automerge.decodeSyncState(input.encodedSyncState);
  const [nextState, payload] = Automerge.generateSyncMessage(
    input.document,
    state,
  );
  input.persist(
    Automerge.encodeSyncState(nextState),
    input.nextServerSequence + (payload ? 1 : 0),
  );
  if (!payload) return "idle";
  const frame = JSON.stringify({
    v: 1,
    type: "sync",
    planID: input.planID,
    sessionID: input.sessionID,
    seq: input.nextServerSequence,
    frameID: input.frameID,
    payload: base64URL(payload),
  });
  return (await sendPlanSyncFrameIfAuthorized(
    input.hasAuthority,
    input.socket,
    frame,
  ))
    ? "sent"
    : "revoked";
}

export async function advancePlanPeerSessions(
  inputs: readonly PlanPeerSessionInput[],
): Promise<void> {
  await Promise.all(
    inputs.map(async (input) => {
      try {
        await advancePlanPeerSession(input);
      } catch {
        input.socket.close(4400, "invalid_sync_session");
      }
    }),
  );
}
