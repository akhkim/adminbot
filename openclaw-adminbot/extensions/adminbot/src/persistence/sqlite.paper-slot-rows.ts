// A paper-slot row as a record, moved out of persistence/sqlite.ts (a grandfathered file).
import type {
  AdminBotPaperSlot,
  AdminBotPaperSlotRecord,
  AdminBotPaperSlotStatus,
} from "../contracts/paper-slots.js";

export function paperSlotFromRow(row: Record<string, unknown>): AdminBotPaperSlotRecord {
  const text = (key: string): string | undefined => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const optional = <K extends keyof AdminBotPaperSlotRecord>(key: K & string) => {
    const value = text(key);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    paper_id: String(row.paper_id),
    slot: String(row.slot) as AdminBotPaperSlot,
    status: String(row.status) as AdminBotPaperSlotStatus,
    ...optional("url"),
    ...optional("value_text"),
    ...optional("value_note"),
    ...optional("provided_by_member_id"),
    ...optional("provided_at"),
    ...optional("validated_at"),
    ...optional("verified_by"),
    ...optional("verified_at"),
    ...optional("verified_title"),
    ...optional("previous_submission_id"),
    ...(text("identity_review")
      ? {
          identity_review: JSON.parse(text("identity_review")!) as NonNullable<
            AdminBotPaperSlotRecord["identity_review"]
          >,
        }
      : {}),
    ...optional("invalid_reason"),
    ...optional("waived_by_member_id"),
    ...optional("waived_reason"),
  };
}
