/** Validate local-only draft isolation, capacity and source-change safeguards. */
import {
  changeDraft,
  createDraft,
  draftAttributes,
  draftBlockReason,
  draftChanges,
  scheduleFingerprint,
} from "../../custom_components/buderus_rc30/www/buderus-rc30-schedule-card.js";

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
function assert(value) {
  if (!value) throw new Error("Assertion failed");
}
function throws(callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  assert(failed);
}
function source(count = 38) {
  const days = ["mo", "tu", "we", "th", "fr", "sa", "su"];
  return {
    state: String(count),
    attributes: {
      heating_circuit: 1,
      schedule_program: "own 1",
      active_program: "own 1",
      capacity: 42,
      free_slots: 42 - count,
      verified_at: new Date().toISOString(),
      slots: Array.from({ length: 42 }, (_, index) => ({
        slot: String(index).padStart(2, "0"),
        occupied: index < count,
        day: index < count ? days[Math.floor(index / 6)] : null,
        time: index < count ? `${String(index % 6).padStart(2, "0")}:00` : null,
        mode: index < count ? (index % 2 ? "off" : "on") : null,
      })),
    },
  };
}

Deno.test("draft changes never mutate source attributes or previous draft versions", () => {
  const entity = source();
  const before = JSON.stringify(entity);
  const draft = createDraft(entity.attributes, entity.state);
  const next = changeDraft(draft, 0, { day: "mo", time: "06:10", mode: "on" });
  equal(JSON.stringify(entity), before);
  equal(draft.slots[0].time, "00:00");
  equal(next.slots[0].time, "06:10");
  equal(next.slots[1], draft.slots[1]);
});
Deno.test("adding allocates the lowest free physical slot and recomputes capacity", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  const next = changeDraft(draft, null, {
    day: "su",
    time: "08:00",
    mode: "on",
  });
  equal(next.slots[38].occupied, true);
  equal(draftAttributes(next).free_slots, 3);
  equal(draftChanges(next).length, 1);
});
Deno.test("42 occupied slots prevent additions but permit existing-point edits", () => {
  const entity = source(42);
  const draft = createDraft(entity.attributes, entity.state);
  throws(() =>
    changeDraft(draft, null, { day: "su", time: "08:00", mode: "on" })
  );
  const next = changeDraft(draft, 0, { day: "mo", time: "00:10", mode: "on" });
  equal(draftAttributes(next).free_slots, 0);
});
Deno.test("delete preserves all physical indexes and a later add reuses the empty slot", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  const deleted = changeDraft(draft, 3, null);
  equal(deleted.slots[3], {
    slot: "03",
    occupied: false,
    day: null,
    time: null,
    mode: null,
  });
  equal(deleted.slots[4].slot, "04");
  const added = changeDraft(deleted, null, {
    day: "sa",
    time: "08:00",
    mode: "on",
  });
  equal(added.slots[3].day, "sa");
  equal(draftChanges(added).length, 1);
});
Deno.test("invalid times, modes, duplicate conflicts and indexes leave drafts intact", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  const before = JSON.stringify(draft);
  for (
    const point of [
      { day: "mo", time: "06:35", mode: "on" },
      { day: "mo", time: "25:00", mode: "on" },
      { day: "mo", time: "06:30", mode: "T2" },
      { day: "su", time: "24:00", mode: "off" },
    ]
  ) throws(() => changeDraft(draft, null, point));
  for (const index of [-1, 42, NaN, "00", true]) {
    throws(() => changeDraft(draft, index, null));
  }
  throws(() => changeDraft(draft, 41, null));
  equal(JSON.stringify(draft), before);
});
Deno.test("restoring the original point removes its change from the preview", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  const changed = changeDraft(draft, 0, {
    day: "mo",
    time: "00:10",
    mode: "on",
  });
  const restored = changeDraft(changed, 0, draft.slots[0]);
  equal(draftChanges(restored), []);
});
Deno.test("poll timestamp and physical array order do not create false conflicts", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  entity.attributes.verified_at = new Date(Date.now() + 1000).toISOString();
  entity.attributes.slots.reverse();
  equal(scheduleFingerprint(entity.attributes), draft.fingerprint);
  equal(draftBlockReason(entity, draft), null);
});
Deno.test("actual source schedule changes pause an existing draft", () => {
  const entity = source();
  const draft = createDraft(entity.attributes, entity.state);
  entity.attributes.slots[0].time = "00:10";
  assert(draftBlockReason(entity, draft)?.includes("geändert"));
});
Deno.test("offline, future, inactive and malformed sources block editing", () => {
  for (
    const mutate of [
      (entity) => entity.state = "unavailable",
      (entity) =>
        entity.attributes.verified_at = new Date(Date.now() + 10 * 60_000)
          .toISOString(),
      (entity) => entity.attributes.active_program = "own 2",
      (entity) => entity.attributes.slots.pop(),
    ]
  ) {
    const entity = source();
    const draft = createDraft(entity.attributes, entity.state);
    mutate(entity);
    assert(draftBlockReason(entity, draft));
  }
  assert(draftBlockReason(null, null));
});
