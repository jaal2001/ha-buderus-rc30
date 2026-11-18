/** Verify range editing preserves the rest of the cyclic week and physical slots. */
import {
  changeDraftPeriod,
  createDraft,
  dayHeatingPeriods,
  draftAttributes,
} from "../../custom_components/buderus_rc30/www/buderus-rc30-schedule-card.js";

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function throws(callback) {
  let caught = false;
  try {
    callback();
  } catch {
    caught = true;
  }
  if (!caught) throw new Error("Expected rejection");
}
function draft(points) {
  const attrs = {
    heating_circuit: 1,
    schedule_program: "own 1",
    active_program: "own 1",
    capacity: 42,
    free_slots: 42 - points.length,
    slots: Array.from(
      { length: 42 },
      (_, index) => ({
        slot: String(index).padStart(2, "0"),
        occupied: index < points.length,
        day: points[index]?.[0] ?? null,
        time: points[index]?.[1] ?? null,
        mode: points[index]?.[2] ?? null,
      }),
    ),
  };
  return createDraft(attrs, String(points.length));
}
const ordinary = () =>
  draft([["mo", "06:00", "on"], ["mo", "09:00", "off"], ["tu", "06:00", "on"], [
    "tu",
    "09:00",
    "off",
  ]]);

Deno.test("editing a range updates both boundaries together without mutating the source", () => {
  const original = ordinary();
  const saved = JSON.stringify(original);
  const next = changeDraftPeriod(original, 0, 0, "07:00", "10:00");
  equal(dayHeatingPeriods(next, 0), [{ start: 420, end: 600 }]);
  equal(dayHeatingPeriods(next, 1), [{ start: 360, end: 540 }]);
  equal(next.slots.slice(2), original.slots.slice(2));
  equal(JSON.stringify(original), saved);
});
Deno.test("adding and removing a heating range allocates and frees its transitions", () => {
  const original = ordinary();
  const added = changeDraftPeriod(original, 0, null, "10:00", "11:00");
  equal(dayHeatingPeriods(added, 0), [{ start: 360, end: 540 }, {
    start: 600,
    end: 660,
  }]);
  equal(draftAttributes(added).free_slots, 36);
  const removed = changeDraftPeriod(added, 0, 1, null, null);
  equal(dayHeatingPeriods(removed, 0), dayHeatingPeriods(original, 0));
  equal(draftAttributes(removed).free_slots, 38);
});
Deno.test("touching heating ranges merge, overlapping ranges are rejected", () => {
  const original = ordinary();
  const merged = changeDraftPeriod(original, 0, null, "09:00", "10:00");
  equal(dayHeatingPeriods(merged, 0), [{ start: 360, end: 600 }]);
  equal(draftAttributes(merged).free_slots, 38);
  throws(() => changeDraftPeriod(original, 0, null, "08:00", "10:00"));
});
Deno.test("24:00 edits preserve the following day's existing heating periods", () => {
  const original = ordinary();
  const next = changeDraftPeriod(original, 0, 0, "06:00", "24:00");
  equal(dayHeatingPeriods(next, 0), [{ start: 360, end: 1440 }]);
  equal(dayHeatingPeriods(next, 1), dayHeatingPeriods(original, 1));
});
Deno.test("editing inherited overnight heating does not change the preceding Sunday", () => {
  const original = draft([["su", "22:00", "on"], ["mo", "02:00", "off"]]);
  const next = changeDraftPeriod(original, 0, 0, "01:00", "03:00");
  equal(dayHeatingPeriods(next, 0), [{ start: 60, end: 180 }]);
  equal(dayHeatingPeriods(next, 6), [{ start: 1320, end: 1440 }]);
});
Deno.test("Sunday boundary changes preserve Monday across the week wrap", () => {
  const original = draft([["su", "22:00", "on"], ["mo", "02:00", "off"]]);
  const next = changeDraftPeriod(original, 6, 0, "21:00", "23:00");
  equal(dayHeatingPeriods(next, 6), [{ start: 1260, end: 1380 }]);
  equal(dayHeatingPeriods(next, 0), [{ start: 0, end: 120 }]);
});
Deno.test("an existing Sunday 24:00 slot stays unchanged when it is still needed", () => {
  const original = draft([["su", "24:00", "on"], ["mo", "06:00", "off"]]);
  const next = changeDraftPeriod(original, 6, null, "20:00", "22:00");
  equal(next.slots[0], original.slots[0]);
  equal(dayHeatingPeriods(next, 0), [{ start: 0, end: 360 }]);
});
Deno.test("a full schedule rejects extra transitions but permits same-capacity edits", () => {
  const days = ["mo", "tu", "we", "th", "fr", "sa", "su"];
  const original = draft(
    Array.from(
      { length: 42 },
      (
        _,
        index,
      ) => [
        days[Math.floor(index / 6)],
        `${String(index % 6).padStart(2, "0")}:00`,
        index % 2 ? "off" : "on",
      ],
    ),
  );
  throws(() => changeDraftPeriod(original, 0, null, "06:00", "07:00"));
  const next = changeDraftPeriod(original, 0, 0, "00:10", "01:00");
  equal(draftAttributes(next).free_slots, 0);
  equal(dayHeatingPeriods(next, 0)[0], { start: 10, end: 60 });
});
Deno.test("unchanged Apply does not consume slots or remove redundant transitions", () => {
  const original = draft([["mo", "06:00", "on"], ["mo", "07:00", "on"], [
    "mo",
    "09:00",
    "off",
  ]]);
  equal(changeDraftPeriod(original, 0, 0, "06:00", "09:00"), original);
});
Deno.test("empty schedules can receive a first heating range", () => {
  const next = changeDraftPeriod(draft([]), 2, null, "06:00", "09:00");
  equal(dayHeatingPeriods(next, 2), [{ start: 360, end: 540 }]);
  equal(draftAttributes(next).free_slots, 40);
});
Deno.test("removing a full-day range restores the following day at midnight", () => {
  const original = draft([["mo", "00:00", "on"]]);
  const next = changeDraftPeriod(original, 1, 0, null, null);
  equal(dayHeatingPeriods(next, 1), []);
  equal(dayHeatingPeriods(next, 0), [{ start: 0, end: 1440 }]);
  equal(dayHeatingPeriods(next, 2), [{ start: 0, end: 1440 }]);
});
Deno.test("invalid or reversed times and missing ranges are rejected atomically", () => {
  const original = ordinary();
  const saved = JSON.stringify(original);
  for (
    const [from, to] of [
      ["06:35", "09:00"],
      ["09:00", "06:00"],
      ["22:00", "02:00"],
      ["24:00", "24:00"],
      ["06:00", "25:00"],
    ]
  ) throws(() => changeDraftPeriod(original, 0, 0, from, to));
  throws(() => changeDraftPeriod(original, 0, 9, "06:00", "09:00"));
  equal(JSON.stringify(original), saved);
});
Deno.test("sequential day edits preserve every other day's full heating ranges", () => {
  const days = ["mo", "tu", "we", "th", "fr", "sa", "su"];
  let current = draft(
    days.flatMap((
      day,
    ) => [[day, "06:00", "on"], [day, "09:00", "off"], [day, "16:00", "on"], [
      day,
      "21:00",
      "off",
    ]]),
  );
  for (let target = 0; target < 7; target++) {
    const before = days.map((_, index) => dayHeatingPeriods(current, index));
    current = changeDraftPeriod(current, target, 0, "05:00", "08:00");
    for (let other = 0; other < 7; other++) {
      if (other !== target) {
        equal(dayHeatingPeriods(current, other), before[other]);
      }
    }
  }
});
