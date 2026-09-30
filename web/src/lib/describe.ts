import type { Alert } from "./types";

const KIND: Record<string, string> = {
  DEVICE_OFFLINE: "A device has not contacted the service for a prolonged period.",
  BACKLOG_HIGH: "A device is holding a large backlog of unsynchronised events.",
  STORAGE_LOW: "A device is running out of local storage; new events may not be recorded.",
  EVENT_QUARANTINED: "An event failed integrity or schema checks and was set aside. The device is blocked until a reviewer decides.",
  CONFLICT_OPEN: "Two edits diverged. Nothing was overwritten; a reviewer must decide.",
};
export const describeAlert = (a: Pick<Alert, "kind">): string => KIND[a.kind] ?? "Operational alert.";

export const REASONS: Record<string, string> = {
  hash_mismatch: "The content hash does not match the event bytes: altered in transit or corrupted on the device.",
  schema_rejected: "The event does not conform to a supported schema version or type.",
  sequence_reuse_mismatch: "A sequence number that was already acknowledged arrived again with different content.",
};
