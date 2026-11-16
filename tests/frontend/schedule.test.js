/** Test cyclic week semantics without a browser or network. */
import {
  buildWeek,
  formatMinute,
  localClock,
  resolveEntity,
} from "../../custom_components/buderus_rc30/www/buderus-rc30-schedule-card.js";

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
function throws(callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Expected validation failure");
}
function attributes(points) {
  return {
    heating_circuit: 1,
    schedule_program: "own 1",
    active_program: "own 1",
    capacity: 42,
    free_slots: 42 - points.length,
    slots: Array.from({ length: 42 }, (_, index) => ({
      slot: String(index).padStart(2, "0"),
      occupied: index < points.length,
      day: points[index]?.[0] ?? null,
      time: points[index]?.[1] ?? null,
      mode: points[index]?.[2] ?? null,
    })),
  };
}

Deno.test("ordinary phases retain physical count and produce full day coverage", () => {
  const week = buildWeek(
    attributes([["mo", "06:00", "on"], ["mo", "09:00", "off"]]),
    "2",
  );
  equal(week.occupied, 2);
  equal(week.days[0].intervals, [
    { start: 0, end: 360, mode: "off" },
    { start: 360, end: 540, mode: "on" },
    { start: 540, end: 1440, mode: "off" },
  ]);
  for (const day of week.days) {
    equal(day.intervals[0].start, 0);
    equal(day.intervals.at(-1).end, 1440);
  }
});
Deno.test("Sunday heating carries into Monday before its first event", () => {
  const week = buildWeek(
    attributes([["su", "22:00", "on"], ["mo", "02:00", "off"]]),
    "2",
  );
  equal(week.days[0].intervals[0], { start: 0, end: 120, mode: "on" });
  equal(week.days[6].intervals.at(-1), { start: 1320, end: 1440, mode: "on" });
});
Deno.test("overnight heating carries between days without inventing midnight switches", () => {
  const week = buildWeek(
    attributes([["tu", "22:00", "on"], ["we", "06:00", "off"]]),
    "2",
  );
  equal(week.days[1].intervals.at(-1), { start: 1320, end: 1440, mode: "on" });
  equal(week.days[2].intervals[0], { start: 0, end: 360, mode: "on" });
});
Deno.test("24:00 is the next day's midnight, including Sunday wrap", () => {
  const week = buildWeek(
    attributes([["su", "24:00", "on"], ["mo", "06:00", "off"]]),
    "2",
  );
  equal(week.days[0].intervals[0], { start: 0, end: 360, mode: "on" });
  equal(formatMinute(1440), "24:00");
});
Deno.test("same-time opposite modes are rejected rather than guessed", () => {
  const data = attributes([["su", "24:00", "on"], ["mo", "00:00", "off"]]);
  throws(() => buildWeek(data, "2"));
});
Deno.test("same-time repeated modes count as slots but share a transition", () => {
  const week = buildWeek(
    attributes([["mo", "06:00", "on"], ["mo", "06:00", "on"]]),
    "2",
  );
  equal(week.occupied, 2);
  equal(week.days[0].intervals.at(-1).mode, "on");
});
Deno.test("empty schedule has no inferred heating or setback mode", () => {
  equal(buildWeek(attributes([]), "0"), { days: [], occupied: 0 });
});
Deno.test("unsorted physical slots are sorted by weekday and time", () => {
  const week = buildWeek(
    attributes([["mo", "09:00", "off"], ["mo", "06:00", "on"]]),
    "2",
  );
  equal(week.days[0].intervals[1], { start: 360, end: 540, mode: "on" });
});
Deno.test("partial, duplicate and inconsistent slot sets are rejected", () => {
  const short = attributes([]);
  short.slots.pop();
  throws(() => buildWeek(short, "0"));
  const duplicate = attributes([]);
  duplicate.slots[41].slot = "00";
  throws(() => buildWeek(duplicate, "0"));
  const staleCount = attributes([]);
  throws(() => buildWeek(staleCount, "38"));
  staleCount.free_slots = 4;
  throws(() => buildWeek(staleCount, "0"));
});
Deno.test("invalid day, mode, time and slot types are rejected", () => {
  for (
    const changes of [
      { day: "xx" },
      { mode: "T2" },
      { time: "24:10" },
      { time: "06:35" },
      { slot: 0 },
      { occupied: "true" },
      { time: "06:00<script>" },
    ]
  ) {
    const data = attributes([["mo", "06:00", "on"]]);
    Object.assign(data.slots[0], changes);
    throws(() => buildWeek(data, "1"));
  }
  const data = attributes([]);
  data.slots[0].day = "mo";
  throws(() => buildWeek(data, "0"));
});
Deno.test("source program and circuit cannot silently change", () => {
  for (
    const change of [{ schedule_program: "own 2" }, { heating_circuit: 2 }, {
      capacity: 43,
    }]
  ) {
    throws(() => buildWeek({ ...attributes([]), ...change }, "0"));
  }
});
Deno.test("autodetection requires exactly one matching sensor", () => {
  const sensor = { attributes: attributes([]) };
  equal(resolveEntity({ "sensor.schedule": sensor }), "sensor.schedule");
  throws(() => resolveEntity({}));
  throws(() => resolveEntity({ "sensor.one": sensor, "sensor.two": sensor }));
  equal(resolveEntity({}, "sensor.explicit"), "sensor.explicit");
});
Deno.test("Home Assistant's timezone determines day and current-time marker", () => {
  const instant = new Date("2026-11-15T23:30:00Z");
  equal(localClock(instant, "Europe/Berlin"), { day: 0, minute: 30 });
  equal(localClock(instant, "UTC"), { day: 6, minute: 1410 });
  equal(localClock(new Date("2026-03-29T01:30:00Z"), "Europe/Berlin"), {
    day: 6,
    minute: 210,
  });
});
