/** RC30 week view and local drafts. No services, API calls or external dependencies. */

const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const LABELS = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const STALE_AFTER = 30 * 60 * 1000;
const TAG = "buderus-rc30-schedule-card";

/** Validate all physical slots before deriving any heating intervals. */
export function buildWeek(attributes, state) {
  if (
    attributes.heating_circuit !== 1 ||
    attributes.schedule_program !== "own 1" ||
    attributes.capacity !== 42 || !Array.isArray(attributes.slots) ||
    attributes.slots.length !== 42
  ) {
    throw new Error(
      "Der Sensor enthält kein vollständiges HC1-Programm mit 42 Slots.",
    );
  }
  const seen = new Set();
  const events = [];
  for (const slot of attributes.slots) {
    if (typeof slot.slot !== "string" || !/^[0-9]{2}$/.test(slot.slot)) {
      throw new Error("Ungültige Slotnummer.");
    }
    const index = Number(slot.slot);
    if (index > 41 || seen.has(index)) {
      throw new Error("Doppelte oder ungültige Slotnummer.");
    }
    seen.add(index);
    if (slot.occupied === false) {
      if (slot.day !== null || slot.time !== null || slot.mode !== null) {
        throw new Error("Ein leerer Slot enthält widersprüchliche Daten.");
      }
      continue;
    }
    if (
      slot.occupied !== true || !DAYS.includes(slot.day) ||
      !["on", "off"].includes(slot.mode)
    ) {
      throw new Error("Nicht unterstützter Schaltpunkt.");
    }
    if (
      typeof slot.time !== "string" || !/^[0-9]{2}:[0-9]{2}$/.test(slot.time)
    ) {
      throw new Error("Ungültige Schaltzeit.");
    }
    const [hour, minute] = slot.time.split(":").map(Number);
    if (
      hour > 24 || minute > 59 || minute % 10 || (hour === 24 && minute !== 0)
    ) {
      throw new Error("Ungültige Schaltzeit.");
    }
    events.push({
      minute: (DAYS.indexOf(slot.day) * DAY_MINUTES + hour * 60 + minute) %
        WEEK_MINUTES,
      mode: slot.mode,
    });
  }
  if (
    String(events.length) !== String(state) ||
    attributes.free_slots !== 42 - events.length
  ) {
    throw new Error("Slotanzahl und Sensorzustand stimmen nicht überein.");
  }
  if (!events.length) return { days: [], occupied: 0 };
  events.sort((left, right) => left.minute - right.minute);
  const distinct = [];
  for (const event of events) {
    const previous = distinct.at(-1);
    if (previous?.minute === event.minute) {
      if (previous.mode !== event.mode) {
        throw new Error("Widersprüchliche Schaltpunkte zur selben Zeit.");
      }
    } else distinct.push(event);
  }
  let mode = distinct.at(-1).mode;
  const days = DAYS.map((day, dayIndex) => {
    const start = dayIndex * DAY_MINUTES;
    const intervals = [];
    let cursor = 0;
    for (const event of distinct) {
      if (event.minute < start || event.minute >= start + DAY_MINUTES) continue;
      const end = event.minute - start;
      if (end > cursor) intervals.push({ start: cursor, end, mode });
      cursor = end;
      mode = event.mode;
    }
    if (cursor < DAY_MINUTES) {
      intervals.push({ start: cursor, end: DAY_MINUTES, mode });
    }
    return { day, intervals };
  });
  return { days, occupied: events.length };
}

/** Resolve an explicit entity or exactly one matching schedule sensor. */
export function resolveEntity(states, configured) {
  if (configured) return configured;
  const matches = Object.entries(states).filter(([id, entity]) =>
    id.startsWith("sensor.") &&
    entity.attributes?.schedule_program === "own 1" &&
    entity.attributes?.heating_circuit === 1 &&
    Array.isArray(entity.attributes?.slots)
  ).map(([id]) => id);
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? "Mehrere RC30-Sensoren gefunden. Bitte im Karteneditor einen auswählen."
        : "Kein RC30-Programmsensor gefunden. Bitte im Karteneditor einen auswählen.",
    );
  }
  return matches[0];
}

/** Use Home Assistant's timezone, including DST, rather than the browser's zone. */
export function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      get("weekday"),
    ),
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function formatMinute(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${
    String(value % 60).padStart(2, "0")
  }`;
}

/** Ignore poll timestamps when detecting changes to the actual source schedule. */
export function scheduleFingerprint(attributes) {
  return JSON.stringify(
    [...attributes.slots].sort((a, b) => Number(a.slot) - Number(b.slot)).map((
      { slot, occupied, day, time, mode },
    ) => [slot, occupied, day, time, mode]),
  );
}

export function createDraft(attributes, state) {
  buildWeek(attributes, state);
  return {
    base: structuredClone(attributes),
    slots: attributes.slots.map((slot) => ({ ...slot })),
    fingerprint: scheduleFingerprint(attributes),
  };
}

export function draftAttributes(draft) {
  const occupied = draft.slots.filter((slot) => slot.occupied).length;
  return { ...draft.base, slots: draft.slots, free_slots: 42 - occupied };
}

/** Return a new draft only after validating the complete resulting week. */
export function changeDraft(draft, index, point) {
  const slots = draft.slots.map((slot) => ({ ...slot }));
  if (index === null) {
    if (point === null) throw new Error("Kein Schaltpunkt ausgewählt.");
    index = slots.filter((slot) =>
      !slot.occupied
    ).map((slot) => Number(slot.slot))
      .sort((a, b) => a - b)[0];
    if (index === undefined) {
      throw new Error(
        "Alle 42 Slots sind belegt. Zuerst einen Schaltpunkt löschen.",
      );
    }
  }
  if (!Number.isInteger(index) || index < 0 || index > 41) {
    throw new Error("Ungültiger Schaltpunkt.");
  }
  const position = slots.findIndex((slot) => Number(slot.slot) === index);
  if (position < 0) throw new Error("Schaltpunkt nicht gefunden.");
  if (point === null && !slots[position].occupied) {
    throw new Error("Dieser Slot ist bereits leer.");
  }
  slots[position] = {
    slot: String(index).padStart(2, "0"),
    occupied: point !== null,
    day: point?.day ?? null,
    time: point?.time ?? null,
    mode: point?.mode ?? null,
  };
  const result = { ...draft, slots };
  const attrs = draftAttributes(result);
  buildWeek(attrs, String(42 - attrs.free_slots));
  return result;
}

export function draftChanges(draft) {
  return draft.slots.flatMap((slot) => {
    const before = draft.base.slots.find((original) =>
      original.slot === slot.slot
    );
    return JSON.stringify([
        before.occupied,
        before.day,
        before.time,
        before.mode,
      ]) ===
        JSON.stringify([slot.occupied, slot.day, slot.time, slot.mode])
      ? []
      : [{ before, after: slot }];
  });
}

export function draftBlockReason(entity, draft, now = Date.now()) {
  if (!entity || ["unavailable", "unknown"].includes(entity.state)) {
    return "Live-Daten sind nicht verfügbar. Der Entwurf bleibt erhalten.";
  }
  try {
    buildWeek(entity.attributes, entity.state);
  } catch {
    return "Live-Daten sind ungültig. Der Entwurf bleibt erhalten.";
  }
  const verified = Date.parse(entity.attributes.verified_at);
  if (
    !Number.isFinite(verified) || now - verified > STALE_AFTER ||
    verified > now + 300_000
  ) {
    return "Ein aktueller verifizierter Abruf wird benötigt. Der Entwurf bleibt erhalten.";
  }
  if (entity.attributes.active_program !== "own 1") {
    return "own 1 ist derzeit nicht aktiv. Die Bearbeitung ist pausiert.";
  }
  if (draft && scheduleFingerprint(entity.attributes) !== draft.fingerprint) {
    return "Das Heizungsprogramm hat sich seit Entwurfsbeginn geändert. Bitte den Entwurf verwerfen und neu beginnen.";
  }
  return null;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

const CSS = `
  :host { display:block; min-width:0; max-width:600px; margin-inline:auto;
    --rc30-on:#d97629; --rc30-track:var(--secondary-background-color,#edf0f2); }
  * { box-sizing:border-box; }
  ha-card { display:block; overflow:hidden; color:var(--primary-text-color,#20262b);
    background:var(--ha-card-background,var(--card-background-color,#fff));
    border:1px solid var(--ha-card-border-color,var(--divider-color,#e1e5e8));
    border-radius:var(--ha-card-border-radius,18px); }
  .body { padding:24px; }
  .eyebrow { font-size:10px; font-weight:700; letter-spacing:.13em;
    color:var(--secondary-text-color,#64717a); margin:0 0 9px; }
  .heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  h2 { margin:0; font-size:23px; font-weight:600; letter-spacing:-.025em; }
  .badge { font-size:11px; padding:6px 9px; border-radius:20px; white-space:nowrap;
    background:var(--rc30-track); color:var(--secondary-text-color,#64717a); }
  .meta { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;
    margin:12px 0 24px; font-size:12px; color:var(--secondary-text-color,#64717a); }
  .legend { display:flex; gap:17px; font-size:11px; margin-bottom:18px;
    color:var(--secondary-text-color,#64717a); }
  .legend span { display:flex; align-items:center; gap:6px; }
  .swatch { width:9px; height:9px; border-radius:3px; background:var(--rc30-track);
    border:1px solid var(--divider-color,#dfe5e9); }
  .swatch.on { background:var(--rc30-on); border-color:var(--rc30-on); }
  .scale { margin-left:45px; position:relative; height:21px; font-size:10px;
    color:var(--secondary-text-color,#64717a); }
  .tick { position:absolute; transform:translateX(-50%); }
  .tick:first-child { transform:none; } .tick:last-child { transform:translateX(-100%); }
  .day { margin:0; }
  .day-button { display:flex; align-items:center; width:100%; gap:12px; padding:9px 0;
    background:none; border:0; color:inherit; font:inherit; text-align:left; cursor:pointer; }
  .day-button:focus-visible { outline:2px solid var(--primary-color,#1673ad); outline-offset:3px;
    border-radius:5px; }
  .label { flex:0 0 33px; font-size:12px; font-weight:500; }
  .today .label { color:var(--primary-color,#1673ad); font-weight:750; }
  .track { position:relative; height:25px; flex:1; min-width:0; border-radius:6px;
    background:var(--rc30-track); overflow:hidden; }
  .segment { position:absolute; top:0; bottom:0; background:var(--rc30-on); }
  .gridline { position:absolute; top:0; bottom:0; width:1px;
    background:var(--ha-card-background,var(--card-background-color,#fff)); opacity:.32; }
  .now { position:absolute; top:0; bottom:0; width:2px; background:var(--primary-color,#1673ad);
    box-shadow:0 0 0 1px var(--ha-card-background,var(--card-background-color,#fff)); }
  .details { margin:0 0 6px 45px; font-size:12px; line-height:1.8;
    color:var(--secondary-text-color,#64717a); }
  .details[hidden] { display:none; }
  .detail-name { display:block; font-weight:600; color:var(--primary-text-color,#20262b); }
  .footer { display:flex; justify-content:space-between; gap:12px; margin-top:19px;
    padding-top:16px; border-top:1px solid var(--divider-color,#e1e5e8);
    font-size:11px; color:var(--secondary-text-color,#64717a); }
  .notice { margin:0 0 16px; border-left:3px solid #cf8d23; padding:9px 12px;
    background:var(--rc30-track); font-size:12px; line-height:1.6; }
  .error { margin-top:18px; font-size:13px; line-height:1.6; }
  .hint { margin:0; color:var(--secondary-text-color,#64717a); font-size:12px; }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-top:18px; }
  .action { font:inherit; font-size:12px; color:var(--primary-text-color,#20262b);
    background:var(--rc30-track); border:1px solid var(--divider-color,#dfe5e9);
    border-radius:8px; padding:9px 12px; cursor:pointer; }
  .action.primary { background:var(--primary-color,#1673ad); color:var(--text-primary-color,#fff); border-color:transparent; }
  .action:disabled { opacity:.45; cursor:not-allowed; }
  .action:focus-visible { outline:2px solid var(--primary-color,#1673ad); outline-offset:3px; }
  .draft-area { border-top:1px solid var(--divider-color,#dfe5e9); margin-top:20px; padding-top:18px; }
  h3 { font-size:16px; margin:0 0 10px; }
  .point-list { list-style:none; padding:0; margin:14px 0; max-height:310px; overflow:auto; }
  .point-row { display:flex; align-items:center; gap:7px; padding:8px 0; border-bottom:1px solid var(--divider-color,#dfe5e9); }
  .point-label { flex:1; font-size:12px; }
  .point-row .action { padding:7px 9px; }
  .point-form { padding:14px; margin:14px 0; background:var(--rc30-track); border-radius:10px; }
  .fields { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
  .fields label { font-size:11px; }
  .fields input,.fields select { width:100%; min-width:0; margin:6px 0; padding:9px 5px;
    border:1px solid var(--divider-color,#aaa); border-radius:5px; font:inherit;
    background:var(--card-background-color,#fff); color:var(--primary-text-color,#20262b); }
  .changes { margin:14px 0; padding-left:20px; font-size:12px; line-height:1.8; }
  .draft-error { color:var(--error-color,#b33b35); font-size:12px; line-height:1.6; }
  @media (max-width:380px) { .body { padding:18px 14px; } h2 { font-size:21px; }
    .meta { font-size:11px; } .footer { flex-direction:column; gap:5px; } }
`;

// The fallback base lets the data functions run in a DOM-free test environment.
const ElementBase = globalThis.HTMLElement ?? class {};

export class BuderusRc30ScheduleCard extends ElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._expanded = new Set();
    this._draft = null;
    this._history = [];
    this._beforeUnload = (event) => {
      if (!this._hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    this.shadowRoot.addEventListener("click", (event) => {
      const action = event.target.closest?.("button[data-action]");
      if (action && !action.disabled) {
        this._handleAction(action.dataset.action, action.dataset.index);
        return;
      }
      const button = event.target.closest?.("button[data-day]");
      if (!button) return;
      const day = Number(button.dataset.day);
      const open = !this._expanded.has(day);
      if (open) this._expanded.add(day);
      else this._expanded.delete(day);
      button.setAttribute("aria-expanded", String(open));
      this.shadowRoot.getElementById(`details-${day}`).hidden = !open;
    });
    this.shadowRoot.addEventListener("input", (event) => {
      const field = event.target.dataset.pointField;
      if (field && this._pointForm) this._pointForm[field] = event.target.value;
    });
    this.shadowRoot.addEventListener("submit", (event) => {
      event.preventDefault();
      this._applyPoint();
    });
  }

  setConfig(config) {
    if (this._draft && config.entity !== this._config?.entity) {
      throw new Error(
        "Bitte den Entwurf verwerfen, bevor der Sensor gewechselt wird.",
      );
    }
    if (
      config.entity !== undefined &&
      (typeof config.entity !== "string" ||
        !config.entity.startsWith("sensor."))
    ) {
      throw new Error("Bitte einen RC30-Programmsensor auswählen.");
    }
    if (config.title !== undefined && typeof config.title !== "string") {
      throw new Error("Der Titel muss Text sein.");
    }
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    // Avoid rebuilding on unrelated entity updates; clock updates have their own timer.
    if (
      this._entity &&
      previous?.states[this._entity] === hass.states[this._entity] &&
      previous?.config?.time_zone === hass.config?.time_zone
    ) return;
    this._render();
  }

  connectedCallback() {
    globalThis.addEventListener("beforeunload", this._beforeUnload);
    this._timer = setInterval(() => this._render(), 60_000);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    globalThis.removeEventListener("beforeunload", this._beforeUnload);
  }

  getCardSize() {
    return 12 + this._expanded.size * 2 + (this._draft ? 14 : 0);
  }
  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6 };
  }
  static getConfigElement() {
    return document.createElement(`${TAG}-editor`);
  }
  static getStubConfig(hass) {
    try {
      return { entity: resolveEntity(hass.states) };
    } catch {
      return {};
    }
  }

  _render() {
    if (!this._config || !this._hass) return;
    let content;
    try {
      this._entity = resolveEntity(this._hass.states, this._config.entity);
      const entity = this._hass.states[this._entity];
      if (!entity) {
        throw new Error("Der ausgewählte Sensor wurde nicht gefunden.");
      }
      if (["unavailable", "unknown"].includes(entity.state)) {
        throw new Error(
          "Programmdaten sind derzeit nicht verfügbar. Bitte die Integration prüfen.",
        );
      }
      const liveWeek = buildWeek(entity.attributes, entity.state);
      const blocked = this._draft && this._draftEntity !== this._entity
        ? "Der Programmsensor hat gewechselt. Bitte den Entwurf verwerfen."
        : draftBlockReason(entity, this._draft);
      const preview = this._draft ? draftAttributes(this._draft) : null;
      const week = preview
        ? buildWeek(preview, String(42 - preview.free_slots))
        : liveWeek;
      const verified = new Date(entity.attributes.verified_at);
      if (!Number.isFinite(verified.getTime())) {
        throw new Error("Der Zeitstempel des Abrufs fehlt.");
      }
      const stale = Date.now() - verified.getTime() > STALE_AFTER;
      const zone = this._hass.config?.time_zone ?? "Europe/Berlin";
      const clock = localClock(new Date(), zone);
      const stamp = new Intl.DateTimeFormat("de-DE", {
        timeZone: zone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(verified);
      const active = entity.attributes.active_program;
      const warnings = [];
      if (this._draft) {
        warnings.push(
          "Entwurfsvorschau – Änderungen sind nur in dieser Karte vorgemerkt. Das Heizungsprogramm bleibt unverändert.",
        );
        if (blocked) warnings.push(escapeHtml(blocked));
      }
      if (active !== "own 1") {
        warnings.push(
          `Angezeigt wird own 1. Aktives Programm: ${
            escapeHtml(active ?? "unbekannt")
          }.`,
        );
      }
      if (stale) {
        warnings.push(
          "Dieser Abruf ist älter als 30 Minuten. Die Zeiten können veraltet sein.",
        );
      }
      content = `
        <div class="meta"><span>${
        escapeHtml(
          active === "own 1" ? "own 1 aktiv" : "own 1 · gespeichertes Programm",
        )
      }</span>
          <span>Stand ${escapeHtml(stamp)}</span></div>
        ${
        warnings.map((warning) =>
          `<p class="notice" role="status">${warning}</p>`
        ).join("")
      }
        ${
        week.days.length
          ? this._weekMarkup(week, stale ? null : clock)
          : '<p class="notice">Keine Schaltpunkte vorhanden. Daraus lässt sich keine Heizphase ableiten.</p>'
      }
        <div class="footer"><span>${week.occupied} / 42 Slots belegt · ${
        42 - week.occupied
      } frei</span>
          <span>Zeitzone ${escapeHtml(zone)}</span></div>
          ${
        this._draft
          ? this._draftPanel(blocked)
          : `<div class="toolbar"><button class="action" type="button" data-action="start" ${
            blocked ? "disabled" : ""
          }>Schaltzeiten als Entwurf bearbeiten</button></div>${
            blocked ? `<p class="hint">${escapeHtml(blocked)}</p>` : ""
          }`
      }`;
    } catch (error) {
      content = `<p class="error" role="alert">${
        escapeHtml(error.message)
      }</p>${
        this._draft
          ? this._draftPanel(
            "Live-Daten fehlen. Die Bearbeitung ist pausiert; dein Entwurf bleibt erhalten.",
          )
          : ""
      }`;
    }
    const focusedDay = this.shadowRoot.activeElement?.dataset.day;
    const focusedField = this.shadowRoot.activeElement?.dataset.pointField;
    this.shadowRoot.innerHTML =
      `<style>${CSS}</style><ha-card><div class="body">
      <p class="eyebrow">Buderus RC30 · Heizkreis 1</p>
      <div class="heading"><h2>${
        escapeHtml(this._config.title ?? "Wochenprogramm")
      }</h2>
        <span class="badge">${
        this._draft ? "Entwurf" : "Nur Lesen"
      }</span></div>${content}</div></ha-card>`;
    if (focusedDay !== undefined) {
      this.shadowRoot.querySelector(`button[data-day="${Number(focusedDay)}"]`)
        ?.focus({ preventScroll: true });
    }
    if (focusedField && ["day", "time", "mode"].includes(focusedField)) {
      this.shadowRoot.querySelector(`[data-point-field="${focusedField}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  _currentEntity() {
    return this._hass?.states[this._entity];
  }

  _handleAction(action, index) {
    this._draftError = null;
    if (
      ["add", "edit", "remove", "undo"].includes(action) &&
      this._pointFormDirty()
    ) {
      this._pendingAction = { action, index };
      this._confirmPointCancel = true;
      this._render();
      return;
    }
    if (action === "discard") {
      if (this._hasUnsavedChanges()) {
        this._confirmDiscard = true;
      } else this._clearDraft();
    } else if (action === "confirm-discard") this._clearDraft();
    else if (action === "keep") this._confirmDiscard = false;
    else if (action === "cancel-point") {
      if (this._pointFormDirty()) this._confirmPointCancel = true;
      else this._pointForm = null;
    } else if (action === "keep-point") {
      this._confirmPointCancel = false;
      this._pendingAction = null;
    } else if (action === "discard-point") {
      this._pointForm = null;
      this._confirmPointCancel = false;
      const pending = this._pendingAction;
      this._pendingAction = null;
      if (pending) {
        this._handleAction(pending.action, pending.index);
        return;
      }
    } else {
      try {
        const blocked = draftBlockReason(this._currentEntity(), this._draft);
        if (blocked) throw new Error(blocked);
        if (action === "start") {
          this._draft = createDraft(
            this._currentEntity().attributes,
            this._currentEntity().state,
          );
          this._draftEntity = this._entity;
          this._history = [];
        } else if (this._draft && this._draftEntity === this._entity) {
          if (action === "add") {
            if (draftAttributes(this._draft).free_slots === 0) {
              throw new Error("Alle 42 Slots sind belegt.");
            }
            this._pointForm = {
              index: null,
              day: "mo",
              time: "06:00",
              mode: "on",
            };
          } else if (action === "edit") {
            const slot = this._draft.slots.find((slot) =>
              slot.slot === index && slot.occupied
            );
            if (!slot) throw new Error("Schaltpunkt nicht gefunden.");
            this._pointForm = {
              index: Number(index),
              day: slot.day,
              time: slot.time,
              mode: slot.mode,
            };
          } else if (action === "remove") {
            const slot = this._draft.slots.find((slot) =>
              slot.slot === index && slot.occupied
            );
            if (!slot) throw new Error("Schaltpunkt nicht gefunden.");
            this._pointForm = { ...slot, index: Number(index), kind: "delete" };
          } else if (action === "undo" && this._history.length) {
            this._draft = this._history.pop();
            this._pointForm = null;
          }
        }
      } catch (error) {
        this._draftError = error.message;
      }
    }
    this._render();
  }

  _remember(next) {
    this._history.push(this._draft);
    if (this._history.length > 42) this._history.shift();
    this._draft = next;
  }

  _clearDraft() {
    this._draft = null;
    this._pointForm = null;
    this._history = [];
    this._confirmDiscard = false;
    this._draftError = null;
    this._confirmPointCancel = false;
    this._pendingAction = null;
  }

  _pointFormDirty() {
    if (!this._pointForm) return false;
    if (this._pointForm.index === null || this._pointForm.kind === "delete") {
      return true;
    }
    const before = this._draft?.slots.find((slot) =>
      Number(slot.slot) === this._pointForm.index
    );
    return !before ||
      ["day", "time", "mode"].some((key) =>
        before[key] !== this._pointForm[key]
      );
  }

  _hasUnsavedChanges() {
    return Boolean(
      this._draft &&
        (draftChanges(this._draft).length || this._pointFormDirty()),
    );
  }

  _applyPoint() {
    try {
      if (
        !this._draft || !this._pointForm || this._draftEntity !== this._entity
      ) return;
      const blocked = draftBlockReason(this._currentEntity(), this._draft);
      if (blocked) throw new Error(blocked);
      this._remember(
        changeDraft(
          this._draft,
          this._pointForm.index,
          this._pointForm.kind === "delete" ? null : this._pointForm,
        ),
      );
      this._pointForm = null;
      this._draftError = null;
      this._confirmPointCancel = false;
      this._pendingAction = null;
    } catch (error) {
      this._draftError = error.message;
    }
    this._render();
  }

  _pointLabel(slot) {
    return slot.occupied
      ? `${LABELS[DAYS.indexOf(slot.day)]} ${slot.time} · ${
        slot.mode === "on" ? "Heizzeit" : "Absenkzeit"
      }`
      : "leer";
  }

  _draftPanel(blocked) {
    const attrs = draftAttributes(this._draft);
    const changes = draftChanges(this._draft);
    const disabled = blocked ? "disabled" : "";
    const points = this._draft.slots.filter((slot) => slot.occupied).sort((
      a,
      b,
    ) =>
      DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
      a.time.localeCompare(b.time) || Number(a.slot) - Number(b.slot)
    );
    return `<section class="draft-area" aria-label="Schaltzeitenentwurf">
      <h3>Schaltpunkte bearbeiten</h3>
      <p class="hint">Entwurf nur in diesem Browser-Tab. Neuladen verwirft ihn. Eine Übertragung an die Heizung ist in dieser Version nicht möglich.</p>
      ${
      blocked
        ? `<p class="notice" role="status">${escapeHtml(blocked)}</p>`
        : ""
    }
      <div class="toolbar"><button class="action primary" type="button" data-action="add" ${
      blocked || attrs.free_slots === 0 ? "disabled" : ""
    }>+ Schaltpunkt</button>
        <button class="action" type="button" data-action="undo" ${
      blocked || !this._history.length ? "disabled" : ""
    }>Rückgängig</button></div>
      ${
      this._confirmDiscard
        ? `<p class="notice" role="alert">Ungespeicherte Änderungen verwerfen? Sie werden nicht gespeichert.</p><div class="toolbar"><button class="action" type="button" data-action="confirm-discard">Änderungen verwerfen</button><button class="action" type="button" data-action="keep">Weiter bearbeiten</button></div>`
        : ""
    }
      ${
      this._draftError
        ? `<p class="draft-error" role="alert">${
          escapeHtml(this._draftError)
        }</p>`
        : ""
    }
      ${this._pointForm ? this._pointFormMarkup(disabled) : ""}
      ${
      this._confirmPointCancel
        ? `<p class="notice" role="alert">Diese Eingabe wurde noch nicht mit Apply bestätigt. Eingabe verwerfen?</p><div class="toolbar"><button class="action" type="button" data-action="discard-point">Eingabe verwerfen</button><button class="action" type="button" data-action="keep-point">Weiter bearbeiten</button></div>`
        : ""
    }
      <ul class="point-list">${
      points.map((slot) =>
        `<li class="point-row"><span class="point-label">${
          escapeHtml(this._pointLabel(slot))
        }</span>
        <button class="action" type="button" data-action="edit" data-index="${slot.slot}" aria-label="Bearbeiten: ${
          escapeHtml(this._pointLabel(slot))
        }" ${disabled}>Bearbeiten</button>
        <button class="action" type="button" data-action="remove" data-index="${slot.slot}" aria-label="Löschen: ${
          escapeHtml(this._pointLabel(slot))
        }" ${disabled}>−</button></li>`
      ).join("")
    }</ul>
      <h3>Änderungsvorschau · ${changes.length}</h3>
      ${
      changes.length
        ? `<ul class="changes">${
          changes.map(({ before, after }) =>
            `<li>${escapeHtml(this._pointLabel(before))} → <strong>${
              escapeHtml(this._pointLabel(after))
            }</strong></li>`
          ).join("")
        }</ul>`
        : '<p class="hint">Noch keine Änderungen.</p>'
    }
      <div class="toolbar"><button class="action" type="button" data-action="discard">Cancel</button><button class="action primary" type="button" data-action="save" disabled title="Die Übertragung an die Heizung ist noch nicht verfügbar.">Save</button></div>
      <p class="hint">Apply bestätigt nur den Entwurf. Save ist noch nicht verfügbar: Die abgesicherte Übertragung an die Heizung folgt separat.</p>
    </section>`;
  }

  _pointFormMarkup(disabled) {
    const point = this._pointForm;
    if (point.kind === "delete") {
      return `<form class="point-form"><h3>Schaltpunkt entfernen</h3><p>${
        escapeHtml(this._pointLabel(point))
      }</p><p class="hint">Apply entfernt diesen Schaltpunkt nur aus dem Entwurf.</p><div class="toolbar"><button class="action primary" type="submit" ${disabled}>Apply</button><button class="action" type="button" data-action="cancel-point">Cancel</button></div></form>`;
    }
    return `<form class="point-form"><h3>${
      point.index === null ? "Neuer Schaltpunkt" : "Schaltpunkt ändern"
    }</h3><div class="fields">
      <label>Tag<select data-point-field="day" ${disabled}>${
      DAYS.map((day, i) =>
        `<option value="${day}" ${point.day === day ? "selected" : ""}>${
          LABELS[i]
        }</option>`
      ).join("")
    }</select></label>
      <label>Uhrzeit<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" data-point-field="time" value="${
      escapeHtml(point.time)
    }" required ${disabled}></label>
      <label>Phase<select data-point-field="mode" ${disabled}><option value="on" ${
      point.mode === "on" ? "selected" : ""
    }>Heizzeit</option><option value="off" ${
      point.mode === "off" ? "selected" : ""
    }>Absenkzeit</option></select></label>
      </div><p class="hint">10-Minuten-Schritte; 24:00 ist möglich.</p>
      <div class="toolbar"><button class="action primary" type="submit" ${disabled}>Apply</button><button class="action" type="button" data-action="cancel-point">Cancel</button></div></form>`;
  }

  _weekMarkup(week, clock) {
    return `<div class="legend"><span><i class="swatch on"></i>Heizzeit</span>
      <span><i class="swatch"></i>Absenkzeit</span></div>
      <div class="scale" aria-hidden="true">${
      [0, 6, 12, 18, 24].map((hour) =>
        `<span class="tick" style="left:${hour / 24 * 100}%">${
          String(hour).padStart(2, "0")
        }</span>`
      ).join("")
    }</div>
      ${
      week.days.map((day, index) => {
        const heating = day.intervals.filter((interval) =>
          interval.mode === "on"
        );
        const ranges = heating.map((interval) =>
          `${formatMinute(interval.start)}–${formatMinute(interval.end)}`
        );
        const readable = ranges.length ? ranges.join(" · ") : "Keine Heizzeit";
        return `<div class="day ${clock?.day === index ? "today" : ""}">
          <button class="day-button" data-day="${index}" type="button"
            aria-expanded="${
          this._expanded.has(index)
        }" aria-controls="details-${index}"
            aria-label="${LABELS[index]}: ${readable}. Details anzeigen.">
            <span class="label">${LABELS[index].slice(0, 2)}</span>
            <span class="track" aria-hidden="true">${
          heating.map((interval) =>
            `<span class="segment" style="left:${
              interval.start / DAY_MINUTES * 100
            }%;width:${
              (interval.end - interval.start) / DAY_MINUTES * 100
            }%"></span>`
          ).join("")
        }${
          [6, 12, 18].map((hour) =>
            `<span class="gridline" style="left:${hour / 24 * 100}%"></span>`
          ).join("")
        }${
          clock?.day === index
            ? `<span class="now" style="left:${
              Math.min(clock.minute / DAY_MINUTES * 100, 99.8)
            }%"></span>`
            : ""
        }</span>
          </button>
          <p class="details" id="details-${index}" ${
          this._expanded.has(index) ? "" : "hidden"
        }>
            <span class="detail-name">${
          LABELS[index]
        }</span>${readable}</p></div>`;
      }).join("")
    }
      <p class="hint">Tag antippen für genaue Zeiten. Angezeigt werden die programmierten Heiz- und Absenkzeiten.</p>`;
  }
}

class BuderusRc30ScheduleEditor extends ElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.addEventListener("change", (event) => {
      const field = event.target.dataset.field;
      if (!field) return;
      const config = { ...this._config, [field]: event.target.value };
      if (!config[field]) delete config[field];
      this._config = config;
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  _render() {
    if (!this._config || !this._hass) return;
    const candidates = Object.entries(this._hass.states).filter(([id, state]) =>
      id.startsWith("sensor.") && state.attributes?.schedule_program === "own 1"
    );
    const signature = JSON.stringify([
      this._config,
      candidates.map(([id]) => id),
    ]);
    if (signature === this._signature) return;
    this._signature = signature;
    if (
      this._config.entity &&
      !candidates.some(([id]) => id === this._config.entity)
    ) {
      candidates.push([this._config.entity, { attributes: {} }]);
    }
    this.shadowRoot.innerHTML = `<style>
      label { display:block; margin:16px 0; font-size:14px; }
      input,select { display:block; width:100%; box-sizing:border-box; margin-top:8px;
        padding:12px; border:1px solid var(--divider-color,#aaa); border-radius:6px;
        background:var(--card-background-color,#fff); color:var(--primary-text-color,#222); font:inherit; }
      p { font-size:13px; color:var(--secondary-text-color,#666); line-height:1.6; }
    </style><label>Programmsensor<select data-field="entity">
      <option value="">Automatisch erkennen (genau ein Sensor)</option>
      ${
      candidates.map(([id, state]) =>
        `<option value="${escapeHtml(id)}" ${
          this._config.entity === id ? "selected" : ""
        }>${escapeHtml(state.attributes.friendly_name ?? id)}</option>`
      ).join("")
    }
      </select></label><label>Titel<input data-field="title" type="text"
        value="${
      escapeHtml(this._config.title ?? "")
    }" placeholder="Wochenprogramm"></label>
      <p>Die Karte liest die vorhandenen Sensorattribute. Sie verändert keine Schaltzeiten.</p>`;
  }
}

if (globalThis.customElements && !customElements.get(TAG)) {
  customElements.define(TAG, BuderusRc30ScheduleCard);
  customElements.define(`${TAG}-editor`, BuderusRc30ScheduleEditor);
  globalThis.customCards = globalThis.customCards ?? [];
  globalThis.customCards.push({
    type: TAG,
    name: "Buderus RC30 Wochenprogramm",
    preview: true,
    description: "Live-Wochenübersicht und lokale Entwürfe für HC1, own 1.",
  });
}
