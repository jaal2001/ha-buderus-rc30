/** Test dialog state and captured markup; browser layout remains a live acceptance check. */
globalThis.HTMLElement = class {
  attachShadow() {
    const listeners = new Map();
    this.shadowRoot = {
      innerHTML: "",
      listeners,
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
      querySelector() {
        return null;
      },
    };
  }
};
const { BuderusRc30ScheduleCard, dayHeatingPeriods } = await import(
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
    callService() {
      throw new Error("The editor must never call a service");
    },
    callApi() {
      throw new Error("The editor must never call the API");
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
function monday() {
  const card = makeCard();
  card._handleAction("day", "0");
  return card;
}
function applyRange(card, action, index, from, to) {
  card._handleAction(action, index);
  card._pointForm.from = from;
  card._pointForm.to = to;
  card._applyPoint();
}

Deno.test("horizontal overview retains seven day rows and the current-time marker", () => {
  const html = render();
  assert(
    (html.match(/class="day-button"/g) ?? []).length === 7,
    "Seven day rows required",
  );
  assert(html.includes('class="now"'), "Time marker missing");
  assert(html.includes("06:00–09:00"), "Accessible exact times missing");
  assert(
    !html.includes('class="point-list"'),
    "Global editing list must be absent",
  );
});
Deno.test("day-row click opens the selected day dialog and creates an isolated draft", () => {
  const card = makeCard();
  card.shadowRoot.listeners.get("click")({
    target: {
      closest(selector) {
        return selector === "button[data-day]"
          ? { dataset: { day: "0" } }
          : null;
      },
    },
  });
  assert(card._dialogDay === 0 && card._draft, "Clicked day did not open");
  const html = card.shadowRoot.innerHTML;
  assert(
    html.includes('<dialog class="day-dialog"'),
    "Native day dialog missing",
  );
  assert(html.includes("Montag · Heizzeiten"), "Selected day title missing");
  assert(html.includes('aria-pressed="true"'), "Active day tab missing");
  assert(html.includes("Aktuelle Uhrzeit:"), "Editing clock missing");
});
Deno.test("range form replaces the clicked row and Apply updates both draft boundaries", () => {
  const card = monday();
  const source = JSON.stringify(card._hass.states);
  card._handleAction("period-edit", "0");
  assert(
    card._pointForm.from === "06:00" && card._pointForm.to === "09:00",
    "Wrong range selected",
  );
  let html = card.shadowRoot.innerHTML;
  assert(
    html.includes('data-point-field="from"') &&
      html.includes('data-point-field="to"'),
    "Inline range fields missing",
  );
  assert(
    !html.includes('class="point-list"'),
    "Global list should not reappear",
  );
  card._pointForm.from = "07:00";
  card._pointForm.to = "10:00";
  card._applyPoint();
  assert(
    JSON.stringify(dayHeatingPeriods(card._draft, 0)) ===
      '[{"start":420,"end":600}]',
    "Range not applied",
  );
  assert(
    card._dialogDay === 0 && !card._pointForm,
    "Apply must keep the day dialog open",
  );
  assert(
    JSON.stringify(card._hass.states) === source,
    "Apply changed live data",
  );
  html = card.shadowRoot.innerHTML;
  assert(
    html.includes("Montag, ungespeicherte Änderungen"),
    "Changed-day indicator missing",
  );
});
Deno.test("adding, deleting and undo remain inside the same day dialog", () => {
  const card = monday();
  applyRange(card, "period-add", undefined, "10:00", "11:00");
  assert(dayHeatingPeriods(card._draft, 0).length === 2, "Range not added");
  card._handleAction("period-remove", "1");
  assert(
    dayHeatingPeriods(card._draft, 0).length === 2,
    "Deletion occurred before Apply",
  );
  card._applyPoint();
  assert(
    dayHeatingPeriods(card._draft, 0).length === 1,
    "Deletion not applied",
  );
  card._handleAction("undo");
  assert(
    dayHeatingPeriods(card._draft, 0).length === 2 && card._dialogDay === 0,
    "Undo lost the day context",
  );
});
Deno.test("day navigation protects pending input and keeps applied edits", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:10";
  card._handleAction("day", "1");
  assert(
    card._confirmPointCancel && card._dialogDay === 0,
    "Switch silently lost input",
  );
  card._handleAction("keep-point");
  assert(card._pointForm.from === "06:10", "Pending input was lost");
  card._applyPoint();
  card._handleAction("day", "1");
  assert(card._dialogDay === 1, "Day tab did not switch");
  assert(
    dayHeatingPeriods(card._draft, 0)[0].start === 370,
    "Applied Monday change was lost",
  );
});
Deno.test("confirmed pending-input discard resumes the selected day action", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:10";
  card._handleAction("day", "1");
  card._handleAction("discard-point");
  assert(
    card._dialogDay === 1 && !card._pointForm,
    "Pending day switch not resumed",
  );
  assert(
    dayHeatingPeriods(card._draft, 0)[0].start === 360,
    "Unapplied input was committed",
  );
});
Deno.test("Cancel and Escape warn before dropping unapplied or applied changes", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:10";
  let prevented = false;
  card.shadowRoot.listeners.get("cancel")({
    target: {
      matches() {
        return true;
      },
    },
    preventDefault() {
      prevented = true;
    },
  });
  assert(
    prevented && card._confirmDiscard && card._draft,
    "Escape did not protect pending input",
  );
  card._handleAction("keep");
  card._applyPoint();
  card._handleAction("discard");
  assert(
    card._confirmDiscard && card._draft,
    "Cancel discarded applied changes silently",
  );
  card._handleAction("confirm-discard");
  assert(
    card._draft === null && card._dialogDay === null,
    "Confirmed Cancel did not close editor",
  );
});
Deno.test("weekly preview closes the dialog without discarding the draft", () => {
  const card = monday();
  applyRange(card, "period-edit", "0", "06:10", "09:10");
  card._handleAction("preview");
  assert(card._dialogDay === null && card._draft, "Preview lost draft");
  assert(
    !card.shadowRoot.innerHTML.includes('<dialog class="day-dialog"'),
    "Preview still covered by modal",
  );
  card._handleAction("day", "0");
  assert(
    card._pointForm === null && card._dialogDay === 0,
    "Day did not reopen cleanly",
  );
});
Deno.test("day-dialog scroll position survives Apply rendering", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  const oldBody = { scrollTop: 135 };
  const newBody = { scrollTop: 0 };
  let rebuilt = false;
  let html = card.shadowRoot.innerHTML;
  Object.defineProperty(card.shadowRoot, "innerHTML", {
    configurable: true,
    get() {
      return html;
    },
    set(value) {
      html = value;
      rebuilt = true;
    },
  });
  card.shadowRoot.querySelector = (selector) =>
    selector === ".dialog-body" ? (rebuilt ? newBody : oldBody) : null;
  card._pointForm.to = "09:10";
  card._applyPoint();
  assert(newBody.scrollTop === 135, "Apply reset the dialog scroll position");
});
Deno.test("unavailable or changed source data pauses edits without losing the form", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:10";
  const saved = JSON.stringify(card._draft);
  card._hass.states["sensor.schedule"].state = "unavailable";
  card._applyPoint();
  assert(
    JSON.stringify(card._draft) === saved && card._pointForm.from === "06:10",
    "Offline Apply lost edits",
  );
  assert(
    card.shadowRoot.innerHTML.includes("pausiert"),
    "Paused message missing",
  );
  card._hass.states["sensor.schedule"].state = "2";
  card._hass.states["sensor.schedule"].attributes.slots[0].time = "06:20";
  card._applyPoint();
  assert(
    card._draftError.includes("geändert"),
    "Changed-source conflict missing",
  );
});
Deno.test("invalid range input stays editable and cannot change the draft", () => {
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:35";
  const saved = JSON.stringify(card._draft);
  card._applyPoint();
  assert(
    card._draftError && card._pointForm &&
      JSON.stringify(card._draft) === saved,
    "Invalid range was applied",
  );
});
Deno.test("unavailable, stale and inactive sources cannot start editing", () => {
  for (
    const options of [{ state: "unavailable" }, { age: 31 * 60_000 }, {
      active: "own 2",
    }]
  ) {
    const card = makeCard(options);
    card._handleAction("day", "0");
    assert(
      card._draft === null && card._dialogDay === null,
      "Unavailable source started editing",
    );
  }
});
Deno.test("stale live data has a warning and no current-time line", () => {
  const html = render({ age: 60 * 60_000 });
  assert(html.includes("älter als 30 Minuten"), "Stale warning missing");
  assert(
    !html.includes('class="now"'),
    "Stale overview should not imply live data",
  );
});
Deno.test("an inactive source program is explicitly identified", () => {
  const html = render({ active: "own 2" });
  assert(html.includes("Aktives Programm: own 2"), "Program warning missing");
});
Deno.test("titles, gateway values and invalid form text cannot inject markup", () => {
  const html = render({
    title: '<img src=x onerror="bad()">',
    active: "<svg onload=bad()>",
  });
  assert(
    !html.includes("<img") && !html.includes("<svg"),
    "Unescaped source markup",
  );
  const card = monday();
  card._handleAction("period-edit", "0");
  card._pointForm.from = "<img src=x>";
  card._applyPoint();
  assert(
    !card.shadowRoot.innerHTML.includes("<img"),
    "Form input was not escaped",
  );
});
Deno.test("invalid slot counts replace the overview with an error", () => {
  const html = render({ state: "38" });
  assert(
    html.includes('role="alert"') && !html.includes('class="track"'),
    "Invalid schedule should not render",
  );
});
Deno.test("browser unload warning protects pending inputs", () => {
  const card = monday();
  let warned = false;
  const event = {
    preventDefault() {
      warned = true;
    },
    returnValue: undefined,
  };
  card._beforeUnload(event);
  assert(!warned, "Unchanged draft requested an unload warning");
  card._handleAction("period-edit", "0");
  card._pointForm.from = "06:10";
  card._beforeUnload(event);
  assert(
    warned && event.returnValue === "",
    "Pending input should trigger warning",
  );
});
Deno.test("Save remains visibly disabled in the day dialog", () => {
  const card = monday();
  assert(
    /data-action="save" disabled/.test(card.shadowRoot.innerHTML),
    "Save must remain unavailable",
  );
  assert(
    card.shadowRoot.innerHTML.includes("Save ist noch nicht verfügbar"),
    "Save status missing",
  );
});
