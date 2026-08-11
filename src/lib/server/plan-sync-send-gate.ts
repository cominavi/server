export interface PlanSyncSocketSender {
  send(message: string): void;
  close(code: number, reason: string): void;
}

export async function sendPlanSyncFrameIfAuthorized(
  hasAuthority: () => Promise<boolean>,
  socket: PlanSyncSocketSender,
  message: string,
): Promise<boolean> {
  if (!(await hasAuthority())) {
    socket.close(4403, "membership_revoked");
    return false;
  }
  socket.send(message);
  return true;
}
