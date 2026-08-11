export interface PlanSyncAuthority {
  userID: number;
  userPublicID: string;
  planID: string;
  authVersion: number;
}

export interface PlanSyncMemberAuthority {
  userID: number;
  userPublicID: string;
  authVersion: number;
  notificationEpoch: number;
}

export interface PlanSyncAuthoritySnapshot {
  membershipEpoch: number;
  planNotificationEpoch: number;
  members: PlanSyncMemberAuthority[];
}

export async function hasPlanSyncAuthority(
  database: D1Database,
  authority: PlanSyncAuthority,
  requireActivePlan: boolean,
): Promise<boolean> {
  const row = await createDatabase(database)
    .select({ archivedAt: sharedPlans.archivedAt })
    .from(users)
    .innerJoin(sharedPlanMembers, eq(sharedPlanMembers.userID, users.id))
    .innerJoin(sharedPlans, eq(sharedPlans.id, sharedPlanMembers.planID))
    .where(
      and(
        eq(users.id, authority.userID),
        eq(users.publicID, authority.userPublicID),
        eq(users.authVersion, authority.authVersion),
        isNull(users.deletionPendingAt),
        eq(sharedPlans.id, authority.planID),
        isNull(sharedPlanMembers.revokedAt),
      ),
    )
    .get();
  return Boolean(row && (!requireActivePlan || row.archivedAt === null));
}

export async function loadPlanSyncAuthoritySnapshot(
  database: D1Database,
  authority: PlanSyncAuthority,
): Promise<PlanSyncAuthoritySnapshot | null> {
  const actor = alias(users, "actor");
  const actorMember = alias(sharedPlanMembers, "actor_member");
  const member = alias(sharedPlanMembers, "member");
  const plan = alias(sharedPlans, "plan");
  const user = alias(users, "member_user");
  const rows = await createDatabase(database)
    .select({
      membershipEpoch: plan.revision,
      planNotificationEpoch: plan.notificationEpoch,
      memberNotificationEpoch: member.notificationEpoch,
      userID: user.id,
      userPublicID: user.publicID,
      authVersion: user.authVersion,
    })
    .from(actor)
    .innerJoin(actorMember, eq(actorMember.userID, actor.id))
    .innerJoin(plan, eq(plan.id, actorMember.planID))
    .innerJoin(member, eq(member.planID, plan.id))
    .innerJoin(user, eq(user.id, member.userID))
    .where(
      and(
        eq(actor.id, authority.userID),
        eq(actor.publicID, authority.userPublicID),
        eq(actor.authVersion, authority.authVersion),
        isNull(actor.deletionPendingAt),
        eq(plan.id, authority.planID),
        isNull(plan.archivedAt),
        isNull(actorMember.revokedAt),
        isNull(member.revokedAt),
        isNull(user.deletionPendingAt),
      ),
    )
    .orderBy(asc(user.id));
  if (rows.length === 0) return null;
  return {
    membershipEpoch: rows[0]!.membershipEpoch,
    planNotificationEpoch: rows[0]!.planNotificationEpoch,
    members: rows.map((row) => ({
      userID: row.userID,
      userPublicID: row.userPublicID,
      authVersion: row.authVersion,
      notificationEpoch: row.memberNotificationEpoch,
    })),
  };
}
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createDatabase } from "../db/client";
import { sharedPlanMembers, sharedPlans, users } from "../db/schema";
