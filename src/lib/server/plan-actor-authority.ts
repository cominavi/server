import { PlanDocumentError, type PlanActorAuthority } from "./plan-document";
import type { PlanSyncAuthoritySnapshot } from "./plan-sync-authority";
import type { SocketAttachment } from "./sync-protocol";

export interface StoredPlanActor {
  actor_id: string;
  user_id: number;
  user_public_id: string;
  replica_id: string;
  auth_version: number;
  membership_epoch: number;
}

export function preparePlanActorAuthorities(
  attachment: SocketAttachment,
  replicaID: string,
  actorID: string,
  snapshot: PlanSyncAuthoritySnapshot,
  rows: readonly StoredPlanActor[],
): {
  actors: Map<string, PlanActorAuthority>;
  actorBinding: PlanActorAuthority;
} {
  const frameMember = snapshot.members.find(
    (member) =>
      member.userID === attachment.userID &&
      member.userPublicID === attachment.userPublicID &&
      member.authVersion === attachment.authVersion,
  );
  if (!frameMember) throw unregisteredActor();
  const existingActor = rows.find((row) => row.actor_id === actorID);
  const existingReplica = rows.find(
    (row) => row.user_id === attachment.userID && row.replica_id === replicaID,
  );
  if (
    (existingActor &&
      (existingActor.user_id !== attachment.userID ||
        existingActor.user_public_id !== attachment.userPublicID ||
        existingActor.replica_id !== replicaID ||
        existingActor.membership_epoch !== frameMember.notificationEpoch)) ||
    (existingReplica &&
      (existingReplica.actor_id !== actorID ||
        existingReplica.membership_epoch !== frameMember.notificationEpoch))
  ) {
    throw unregisteredActor();
  }
  const actorBinding: PlanActorAuthority = {
    actorID,
    userID: attachment.userID,
    userPublicID: attachment.userPublicID,
    replicaID,
    authVersion: attachment.authVersion,
    membershipEpoch: frameMember.notificationEpoch,
  };
  const actors = new Map<string, PlanActorAuthority>();
  for (const row of rows) {
    const member = snapshot.members.find(
      (candidate) =>
        candidate.userID === row.user_id &&
        candidate.userPublicID === row.user_public_id &&
        candidate.authVersion === row.auth_version &&
        candidate.notificationEpoch === row.membership_epoch,
    );
    if (member) {
      actors.set(row.actor_id, {
        actorID: row.actor_id,
        userID: row.user_id,
        userPublicID: row.user_public_id,
        replicaID: row.replica_id,
        authVersion: row.auth_version,
        membershipEpoch: row.membership_epoch,
      });
    }
  }
  actors.set(actorID, actorBinding);
  return { actors, actorBinding };
}

function unregisteredActor(): PlanDocumentError {
  return new PlanDocumentError("unregistered_plan_actor");
}
