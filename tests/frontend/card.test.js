/** Capture generated markup to test safety states; this is not a browser layout test. */
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {
      innerHTML: "",
      addEventListener() {},
    };
  }
};
const { BuderusRc30ScheduleCard } = await import(
  "../../custom_components/buderus_rc30/www/buderus-rc30-schedule-card.js"
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function render(
  { state = "2", active = "own 1", age = 0, title = "Wochenprogramm" } = {},
) {
  const card = new BuderusRc30ScheduleCard();
  card.setConfig({ title });
  card.hass = {
    config: { time_zone: "Europe/Berlin" },
    callService: () => {
      throw new Error("A read-only card must never call a service");
    },
    states: {
      "sensor.schedule": {
        state,
        attributes: {
          heating_circuit: 1,
          schedule_program: "own 1",
          capacity: 42,
          free_slots: 40,
          active_program: active,
          verified_at: new Date(Date.now() - age).toISOString(),
          slots: Array.from({ length: 42 }, (_, index) => ({
            slot: String(index).padStart(2, "0"),
            occupied: index < 2,
            day: index < 2 ? "mo" : null,
            time: index === 0 ? "06:00" : index === 1 ? "09:00" : null,
            mode: index === 0 ? "on" : index === 1 ? "off" : null,
          })),
        },
      },
    },
  };
  return card.shadowRoot.innerHTML;
}

Deno.test("fresh data produces seven accessible day rows and exact detail times", () => {
  const html = render();
  assert(
    (html.match(/class="day-button"/g) ?? []).length === 7,
    "Seven day buttons required",
  );
  assert(html.includes("06:00–09:00"), "Exact times missing");
  assert(
    html.includes("2 / 42 Slots belegt · 40 frei"),
    "Capacity summary missing",
  );
  assert(html.includes('class="now"'), "Fresh data should have a time marker");
  assert(
    html.includes('aria-controls="details-0"'),
    "Accessible day disclosure missing",
  );
});
Deno.test("unavailable data shows a clear error and no old timeline", () => {
  const html = render({ state: "unavailable" });
  assert(html.includes('role="alert"'), "Outage error missing");
  assert(
    !html.includes('class="track"'),
    "Unavailable schedule must not show timelines",
  );
});
Deno.test("old data keeps explicitly dated times but removes the current-time marker", () => {
  const html = render({ age: 60 * 60 * 1000 });
  assert(html.includes("älter als 30 Minuten"), "Stale-data warning missing");
  assert(
    html.includes('class="track"'),
    "Dated schedule should remain inspectable",
  );
  assert(
    !html.includes('class="now"'),
    "Old data must not have a live time marker",
  );
});
Deno.test("a different active program is prominent while own 1 remains the source", () => {
  const html = render({ active: "own 2" });
  assert(
    html.includes("Aktives Programm: own 2"),
    "Inactive-source warning missing",
  );
  assert(
    html.includes("own 1 · gespeichertes Programm"),
    "Source program missing",
  );
});
Deno.test("titles and gateway values cannot inject markup", () => {
  const html = render({
    title: '<img src=x onerror="bad()">',
    active: "<svg onload=bad()>",
  });
  assert(!html.includes("<img"), "Title was not escaped");
  assert(!html.includes("<svg"), "Gateway value was not escaped");
  assert(
    html.includes("&lt;img"),
    "Escaped title should remain visible as text",
  );
});
Deno.test("inconsistent count errors replace the whole timeline", () => {
  const html = render({ state: "38" });
  assert(html.includes('role="alert"'), "Bad-data error missing");
  assert(!html.includes('class="track"'), "Invalid schedule must not be drawn");
});
