export interface PushDeliveryQueueMessage {
  kind?: "push";
  deliveryID: number;
}

export type PushQueueMessage = PushDeliveryQueueMessage;

export async function enqueuePushDeliveries(
  queue: Queue<PushQueueMessage>,
  deliveryIDs: number[],
): Promise<void> {
  const unique = Array.from(new Set(deliveryIDs)).filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  for (let offset = 0; offset < unique.length; offset += 100) {
    await queue.sendBatch(
      unique.slice(offset, offset + 100).map((deliveryID) => ({
        body: { kind: "push" as const, deliveryID },
      })),
    );
  }
}

export async function enqueuePendingPushDeliveries(
  database: D1Database,
  queue: Queue<PushQueueMessage>,
  nowMilliseconds = Date.now(),
): Promise<number> {
  const now = Math.floor(nowMilliseconds / 1_000);
  // A Worker can be terminated after claiming a delivery but before it can
  // put that delivery back into retry. Reclaim expired leases before scanning
  // so a crash cannot strand a notification in `processing` forever.
  await database
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'retry', available_at = ?1, lease_expires_at = NULL,
           last_error = COALESCE(last_error, 'processing_lease_expired'),
           updated_at = ?1
       WHERE status = 'processing'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1`,
    )
    .bind(now)
    .run();
  const rows = await database
    .prepare(
      `SELECT id
       FROM notification_deliveries
       WHERE status IN ('pending', 'retry') AND available_at <= ?1
       ORDER BY available_at, id
       LIMIT 500`,
    )
    .bind(now)
    .all<{ id: number }>();
  await enqueuePushDeliveries(
    queue,
    rows.results.map((row) => row.id),
  );
  return rows.results.length;
}
