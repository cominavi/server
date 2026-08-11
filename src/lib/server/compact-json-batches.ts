export const targetCompactJSONBatchBytes = 512 * 1024;

export function compactSerializedJSONValues(
  serializedValues: readonly string[],
  targetBytes = targetCompactJSONBatchBytes,
): string[] {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 3)
    throw new Error("invalid_compact_json_batch_target");
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let values: string[] = [];
  let bytes = 2;
  const flush = () => {
    if (values.length === 0) return;
    batches.push(`[${values.join(",")}]`);
    values = [];
    bytes = 2;
  };
  for (const serialized of serializedValues) {
    JSON.parse(serialized);
    const valueBytes = encoder.encode(serialized).byteLength;
    const separatorBytes = values.length === 0 ? 0 : 1;
    if (values.length > 0 && bytes + separatorBytes + valueBytes > targetBytes)
      flush();
    values.push(serialized);
    bytes += (values.length === 1 ? 0 : 1) + valueBytes;
  }
  flush();
  return batches;
}
