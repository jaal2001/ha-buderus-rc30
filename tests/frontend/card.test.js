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
function makeCard(
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
  return card;
}

function render(options) {
  return makeCard(options).shadowRoot.innerHTML;
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

Deno.test("local add, edit, remove and undo keep the original sensor unchanged", () => {
  const card = makeCard();
  const source = JSON.stringify(card._hass.states);
  card._handleAction("start");
  assert(card._draft, "Draft should start");
  card._handleAction("add");
  card._pointForm = { index: null, day: "tu", time: "08:00", mode: "on" };
  card._applyPoint();
  assert(card._draft.slots[2].day === "tu", "New point not added");
  card._handleAction("edit", "02");
  card._pointForm.time = "08:10";
  card._applyPoint();
  assert(card._draft.slots[2].time === "08:10", "Point not edited");
  card._handleAction("remove", "02");
  card._applyPoint();
  assert(!card._draft.slots[2].occupied, "Point not removed");
  card._handleAction("undo");
  assert(card._draft.slots[2].time === "08:10", "Undo did not restore point");
  assert(JSON.stringify(card._hass.states) === source, "Live data was mutated");
  assert(
    card.shadowRoot.innerHTML.includes("Entwurfsvorschau"),
    "Draft must be labeled",
  );
  assert(
    card.shadowRoot.innerHTML.includes('class="now"'),
    "Current-time marker should remain visible while editing a draft",
  );
});

Deno.test("discard requires confirmation and cancel keeps the draft", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("remove", "00");
  card._applyPoint();
  card._handleAction("discard");
  assert(
    card._confirmDiscard && card._draft,
    "Changed draft requires confirmation",
  );
  card._handleAction("keep");
  assert(!card._confirmDiscard && card._draft, "Cancel should keep edits");
  card._handleAction("discard");
  card._handleAction("confirm-discard");
  assert(card._draft === null, "Draft not discarded");
  assert(
    card._hass.states["sensor.schedule"].attributes.slots[0].occupied,
    "Source changed",
  );
});

Deno.test("loss of connectivity preserves the draft and blocks further mutation", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("remove", "00");
  card._applyPoint();
  const saved = JSON.stringify(card._draft);
  card._hass.states["sensor.schedule"].state = "unavailable";
  card._handleAction("remove", "01");
  assert(
    JSON.stringify(card._draft) === saved,
    "Offline action changed the draft",
  );
  assert(
    card.shadowRoot.innerHTML.includes("pausiert"),
    "Paused status missing",
  );
  card._hass.states["sensor.schedule"].state = "2";
  card._hass.states["sensor.schedule"].attributes.verified_at = new Date()
    .toISOString();
  card._handleAction("edit", "01");
  assert(
    card._pointForm.index === 1,
    "Same-source recovery should allow editing",
  );
});

Deno.test("a changed source blocks an open form's save and retains edits", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("edit", "00");
  card._pointForm.time = "06:10";
  card._hass.states["sensor.schedule"].attributes.slots[0].time = "06:20";
  card._applyPoint();
  assert(card._draft.slots[0].time === "06:00", "Conflict save should fail");
  assert(card._draftError.includes("geändert"), "Conflict explanation missing");
  assert(
    card._pointForm.time === "06:10",
    "User form input should be retained",
  );
});

Deno.test("unavailable, stale and inactive sources cannot start a draft", () => {
  for (
    const options of [{ state: "unavailable" }, { age: 31 * 60_000 }, {
      active: "own 2",
    }]
  ) {
    const card = makeCard(options);
    card._handleAction("start");
    assert(card._draft === null, "Invalid source started a draft");
  }
});

Deno.test("invalid form input stays editable and never changes the draft", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("add");
  card._pointForm.time = "06:35";
  const before = JSON.stringify(card._draft);
  card._applyPoint();
  assert(JSON.stringify(card._draft) === before, "Invalid time was applied");
  assert(
    card._pointForm && card._draftError,
    "Form and validation error should remain",
  );
});

Deno.test("deletion requires Apply and cancelling it preserves the draft", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("remove", "00");
  assert(card._draft.slots[0].occupied, "Deletion happened before Apply");
  card._handleAction("cancel-point");
  assert(card._confirmPointCancel, "Pending deletion requires warning");
  card._handleAction("discard-point");
  assert(
    card._draft.slots[0].occupied && !card._pointForm,
    "Cancel changed the draft",
  );
  card._handleAction("remove", "00");
  card._applyPoint();
  assert(!card._draft.slots[0].occupied, "Apply should stage deletion");
  assert(
    card._hass.states["sensor.schedule"].attributes.slots[0].occupied,
    "Apply changed live data",
  );
});

Deno.test("Cancel warns about unapplied edits before any applied change", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("edit", "00");
  card._pointForm.time = "06:10";
  card._handleAction("discard");
  assert(card._confirmDiscard, "Unapplied input must trigger Cancel warning");
  card._handleAction("keep");
  assert(card._pointForm.time === "06:10", "Continuing must preserve input");
});

Deno.test("switching points requires confirmation before dropping unapplied input", () => {
  const card = makeCard();
  card._handleAction("start");
  card._handleAction("edit", "00");
  card._pointForm.time = "06:10";
  card._handleAction("edit", "01");
  assert(
    card._confirmPointCancel && card._pointForm.index === 0,
    "Pending edit was lost",
  );
  card._handleAction("keep-point");
  assert(card._pointForm.time === "06:10", "Continue should retain input");
  card._handleAction("edit", "01");
  card._handleAction("discard-point");
  assert(
    card._pointForm.index === 1,
    "Confirmed switch did not open next point",
  );
  assert(card._draft.slots[0].time === "06:00", "Discarded input was applied");
});

Deno.test("browser unload warning is requested only for unsaved changes", () => {
  const card = makeCard();
  let warned = false;
  const event = {
    preventDefault() {
      warned = true;
    },
    returnValue: undefined,
  };
  card._handleAction("start");
  card._beforeUnload(event);
  assert(!warned, "Unchanged draft should not request an unload warning");
  card._handleAction("edit", "00");
  card._pointForm.time = "06:10";
  card._beforeUnload(event);
  assert(
    warned && event.returnValue === "",
    "Unsaved input should request browser confirmation",
  );
});

Deno.test("Save is visibly unavailable until controller transmission exists", () => {
  const card = makeCard();
  card._handleAction("start");
  assert(
    /data-action="save" disabled/.test(card.shadowRoot.innerHTML),
    "Save must not imply working transmission",
  );
  assert(
    card.shadowRoot.innerHTML.includes("Save ist noch nicht verfügbar"),
    "Save status is unclear",
  );
});
