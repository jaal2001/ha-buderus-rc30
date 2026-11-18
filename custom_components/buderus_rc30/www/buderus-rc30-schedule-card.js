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

/** Return continuous heating ranges for a day, including inherited overnight mode. */
export function dayHeatingPeriods(draft, dayIndex) {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    throw new Error("Ungültiger Tag.");
  }
  const attrs = draftAttributes(draft);
  const day = buildWeek(attrs, String(42 - attrs.free_slots)).days[dayIndex];
  const periods = [];
  for (const interval of day?.intervals ?? []) {
    if (interval.mode !== "on") continue;
    const previous = periods.at(-1);
    if (previous?.end === interval.start) previous.end = interval.end;
    else periods.push({ start: interval.start, end: interval.end });
  }
  return periods;
}

function parseMinute(value) {
  if (typeof value !== "string" || !/^[0-9]{2}:[0-9]{2}$/.test(value)) {
    throw new Error("Bitte eine Uhrzeit als HH:MM eingeben.");
  }
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 24 || minute > 59 || minute % 10 || (hour === 24 && minute)) {
    throw new Error(
      "Bitte 10-Minuten-Schritte zwischen 00:00 und 24:00 verwenden.",
    );
  }
  return hour * 60 + minute;
}

/** Rebuild only the selected day's transitions and its midnight boundary. */
export function changeDraftPeriod(draft, dayIndex, periodIndex, from, to) {
  const original = dayHeatingPeriods(draft, dayIndex);
  const periods = original.map((period) => ({ ...period }));
  if (
    periodIndex !== null &&
    (!Number.isInteger(periodIndex) || !periods[periodIndex])
  ) throw new Error("Zeitraum nicht gefunden.");
  if (from === null && to === null) {
    if (periodIndex === null) throw new Error("Kein Zeitraum ausgewählt.");
    periods.splice(periodIndex, 1);
  } else {
    const period = { start: parseMinute(from), end: parseMinute(to) };
    if (period.start >= period.end) {
      throw new Error(
        "Das Ende muss nach dem Beginn liegen. Über Mitternacht bitte beide Tage bearbeiten.",
      );
    }
    if (periodIndex === null) periods.push(period);
    else periods[periodIndex] = period;
  }
  periods.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const period of periods) {
    const previous = merged.at(-1);
    if (previous && previous.end > period.start) {
      throw new Error("Heizzeiten dürfen sich nicht überschneiden.");
    }
    if (previous?.end === period.start) previous.end = period.end;
    else merged.push({ ...period });
  }
  if (JSON.stringify(original) === JSON.stringify(merged)) return draft;
  const attrs = draftAttributes(draft);
  const before = buildWeek(attrs, String(42 - attrs.free_slots));
  const previousMode =
    before.days[(dayIndex + 6) % 7]?.intervals.at(-1)?.mode ?? "off";
  const followingMode = before.days[(dayIndex + 1) % 7]?.intervals[0]?.mode ??
    "off";
  const start = dayIndex * DAY_MINUTES;
  const nextStart = (start + DAY_MINUTES) % WEEK_MINUTES;
  const effectiveMinute = (slot) => {
    const [hour, minute] = slot.time.split(":").map(Number);
    return (DAYS.indexOf(slot.day) * DAY_MINUTES + hour * 60 + minute) %
      WEEK_MINUTES;
  };
  const existingBoundary = (minute, mode) =>
    draft.slots.some((slot) =>
      slot.occupied && effectiveMinute(slot) === minute && slot.mode === mode
    );
  const desired = new Map();
  const firstMode = merged[0]?.start === 0 ? "on" : "off";
  const lastMode = merged.at(-1)?.end === DAY_MINUTES ? "on" : "off";
  if (previousMode !== firstMode || existingBoundary(start, firstMode)) {
    desired.set(start, firstMode);
  }
  for (const period of merged) {
    if (period.start > 0) desired.set(start + period.start, "on");
    if (period.end < DAY_MINUTES) desired.set(start + period.end, "off");
  }
  if (
    lastMode !== followingMode || existingBoundary(nextStart, followingMode)
  ) {
    desired.set(nextStart, followingMode);
  }
  const slots = draft.slots.map((slot) => {
    if (!slot.occupied) return { ...slot };
    const minute = effectiveMinute(slot);
    if (
      (minute >= start && minute < start + DAY_MINUTES) || minute === nextStart
    ) {
      if (desired.get(minute) !== slot.mode) {
        return {
          slot: slot.slot,
          occupied: false,
          day: null,
          time: null,
          mode: null,
        };
      }
    }
    return { ...slot };
  });
  for (const [minute, mode] of desired) {
    if (
      slots.some((slot) =>
        slot.occupied && effectiveMinute(slot) === minute && slot.mode === mode
      )
    ) continue;
    const empty = slots.filter((slot) =>
      !slot.occupied
    ).sort((a, b) => Number(a.slot) - Number(b.slot))[0];
    if (!empty) {
      throw new Error(
        "Für diesen Zeitraum reichen die 42 Slots nicht aus. Bitte zuerst einen Zeitraum entfernen.",
      );
    }
    Object.assign(empty, {
      occupied: true,
      day: DAYS[Math.floor(minute / DAY_MINUTES)],
      time: formatMinute(minute % DAY_MINUTES),
      mode,
    });
  }
  const result = { ...draft, slots };
  const afterAttrs = draftAttributes(result);
  buildWeek(afterAttrs, String(42 - afterAttrs.free_slots));
  if (
    JSON.stringify(dayHeatingPeriods(result, dayIndex)) !==
      JSON.stringify(merged)
  ) {
    throw new Error(
      "Die Tagesvorschau konnte nicht eindeutig erstellt werden.",
    );
  }
  if (before.days.length) {
    for (let day = 0; day < 7; day++) {
      if (
        day !== dayIndex &&
        JSON.stringify(dayHeatingPeriods(draft, day)) !==
          JSON.stringify(dayHeatingPeriods(result, day))
      ) throw new Error("Die Änderung würde einen anderen Tag beeinflussen.");
    }
  }
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
  .point-form { padding:14px; margin:14px 0; background:var(--rc30-track); border-radius:10px; }
  .fields { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
  .fields label { font-size:11px; }
  .fields input,.fields select { width:100%; min-width:0; margin:6px 0; padding:9px 5px;
    border:1px solid var(--divider-color,#aaa); border-radius:5px; font:inherit;
    background:var(--card-background-color,#fff); color:var(--primary-text-color,#20262b); }
  .changes { margin:14px 0; padding-left:20px; font-size:12px; line-height:1.8; }
  .draft-error { color:var(--error-color,#b33b35); font-size:12px; line-height:1.6; }
  .day-dialog { width:min(740px,calc(100vw - 32px)); max-height:calc(100dvh - 32px);
    padding:0; border:1px solid var(--divider-color,#dfe5e9); border-radius:22px;
    background:var(--ha-card-background,var(--card-background-color,#fff)); color:var(--primary-text-color,#20262b); }
  .day-dialog::backdrop { background:rgba(0,0,0,.4); }
  .dialog-shell { display:flex; flex-direction:column; max-height:calc(100dvh - 36px); }
  .dialog-header { padding:20px 24px 12px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .dialog-header h2 { font-size:21px; }
  .dialog-body { overflow-y:auto; padding:8px 24px 22px; min-height:0; }
  .day-tabs { display:flex; gap:5px; flex-wrap:wrap; margin:12px 0 22px; }
  .day-tab { flex:1; min-width:42px; padding:10px 5px; }
  .day-tab[aria-pressed="true"] { background:var(--primary-color,#1673ad); color:var(--text-primary-color,#fff); }
  .dialog-track { position:relative; height:32px; border-radius:7px; background:var(--rc30-track); overflow:hidden; margin:10px 0 20px; }
  .dialog-track .segment { border:0; cursor:pointer; padding:0; }
  .dialog-track .now { pointer-events:none; }
  .period-row { display:flex; align-items:center; justify-content:space-between; gap:12px;
    width:100%; padding:15px 12px; border:0; border-bottom:1px solid var(--divider-color,#dfe5e9);
    background:transparent; color:inherit; font:inherit; font-size:14px; cursor:pointer; text-align:left; }
  .period-row:hover { background:var(--rc30-track); }
  .period-row .phase { font-size:12px; color:var(--secondary-text-color,#64717a); }
  .period-row .phase.on { color:var(--rc30-on); }
  .period-form .fields { grid-template-columns:1fr 1fr; }
  .dialog-footer { padding:14px 24px 18px; border-top:1px solid var(--divider-color,#dfe5e9); background:inherit; }
  .dialog-footer .toolbar { margin-top:0; justify-content:flex-end; }
  .dialog-status { margin:10px 0; font-size:12px; color:var(--secondary-text-color,#64717a); }
  .day-dialog .point-form { margin:0; border-radius:8px; }
  @media (max-width:380px) { .body { padding:18px 14px; } h2 { font-size:21px; }
    .meta { font-size:11px; } .footer { flex-direction:column; gap:5px; } }
`;

// The fallback base lets the data functions run in a DOM-free test environment.
const ElementBase = globalThis.HTMLElement ?? class {};

export class BuderusRc30ScheduleCard extends ElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._draft = null;
    this._saveStatus = null;
    this._saving = false;
    this._dialogDay = null;
    this._history = [];
    this._beforeUnload = (event) => {
      if (!this._hasUnsavedChanges() && !this._operationLocked()) return;
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
      this._handleAction("day", String(day));
    });
    this.shadowRoot.addEventListener("input", (event) => {
      const field = event.target.dataset.pointField;
      if (field && this._pointForm && !this._operationLocked()) {
        this._pointForm[field] = event.target.value;
        this._confirmSave = false;
      }
    });
    this.shadowRoot.addEventListener("submit", (event) => {
      event.preventDefault();
      this._applyPoint();
    });
    this.shadowRoot.addEventListener("cancel", (event) => {
      if (!event.target.matches?.("dialog.day-dialog")) return;
      event.preventDefault();
      this._handleAction("discard");
    }, true);
    this.shadowRoot.addEventListener("toggle", (event) => {
      if (event.target.matches?.("details[data-changes]")) {
        this._changesOpen = event.target.open;
      }
    }, true);
  }

  setConfig(config) {
    if (
      (this._draft || this._operationLocked()) &&
      config.entity !== this._config?.entity
    ) {
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
      previous?.config?.time_zone === hass.config?.time_zone &&
      previous?.user === hass.user
    ) return;
    this._render();
    if (this._statusEntity !== this._entity) void this._refreshSaveStatus();
  }

  connectedCallback() {
    globalThis.addEventListener("beforeunload", this._beforeUnload);
    this._timer = setInterval(() => {
      this._render();
      void this._refreshSaveStatus();
    }, 60_000);
    this._render();
    void this._refreshSaveStatus();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearTimeout(this._saveTimer);
    globalThis.removeEventListener("beforeunload", this._beforeUnload);
  }

  getCardSize() {
    return 12 + (this._draft ? 4 : 0);
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
    let dialogBlocked = null;
    try {
      const resolved = resolveEntity(this._hass.states, this._config.entity);
      if (this._entity !== resolved) {
        this._saveStatus = null;
        this._statusEntity = null;
        this._confirmRestore = false;
      }
      this._entity = resolved;
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
      dialogBlocked = this._operationLocked()
        ? "Speicherung läuft. Bitte warten."
        : blocked;
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
      if (this._draft && !this._operationLocked()) {
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
          }>Heizzeiten bearbeiten</button></div>${
            blocked ? `<p class="hint">${escapeHtml(blocked)}</p>` : ""
          }`
      }`;
    } catch (error) {
      dialogBlocked =
        "Live-Daten fehlen. Die Bearbeitung ist pausiert; dein Entwurf bleibt erhalten.";
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
    const bodyScroll =
      this.shadowRoot.querySelector?.(".dialog-body")?.scrollTop ?? 0;
    const confirmation = Boolean(
      this._confirmDiscard || this._confirmPointCancel,
    );
    if (confirmation && !this._wasConfirming) this._warningScroll = bodyScroll;
    const selectionStart = this.shadowRoot.activeElement?.selectionStart;
    const selectionEnd = this.shadowRoot.activeElement?.selectionEnd;
    this.shadowRoot.innerHTML =
      `<style>${CSS}</style><ha-card><div class="body">
      <p class="eyebrow">Buderus RC30 · Heizkreis 1</p>
      <div class="heading"><h2>${
        escapeHtml(this._config.title ?? "Wochenprogramm")
      }</h2>
        <span class="badge">${
        this._draft ? "Entwurf" : "Nur Lesen"
      }</span></div>${content}${
        this._dialogDay === null ? this._saveMessages() : ""
      }</div></ha-card>${
        this._draft && this._dialogDay !== null
          ? this._dayDialogMarkup(dialogBlocked)
          : ""
      }`;
    if (this._operationLocked()) {
      for (
        const control
          of this.shadowRoot.querySelectorAll?.("button, input, select") ?? []
      ) control.disabled = true;
    }
    const dialog = this.shadowRoot.querySelector?.("dialog.day-dialog");
    if (dialog && !dialog.open && this.isConnected) dialog.showModal();
    const dialogBody = this.shadowRoot.querySelector?.(".dialog-body");
    if (dialogBody) {
      dialogBody.scrollTop = confirmation
        ? 0
        : this._lastDialogDay !== this._dialogDay
        ? 0
        : this._wasConfirming
        ? this._warningScroll ?? bodyScroll
        : bodyScroll;
    }
    this._lastDialogDay = this._dialogDay;
    this._wasConfirming = confirmation;
    if (focusedDay !== undefined) {
      this.shadowRoot.querySelector(`button[data-day="${Number(focusedDay)}"]`)
        ?.focus({ preventScroll: true });
    }
    if (
      focusedField &&
      ["day", "time", "mode", "from", "to"].includes(focusedField)
    ) {
      const input = this.shadowRoot.querySelector(
        `[data-point-field="${focusedField}"]`,
      );
      input?.focus({ preventScroll: true });
      if (input?.tagName === "INPUT" && typeof selectionStart === "number") {
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  _admin() {
    return this._hass?.user?.is_admin === true &&
      typeof this._hass?.callWS === "function";
  }

  _operationLocked() {
    return Boolean(this._saving || this._uncertain || this._saveStatus?.busy);
  }

  _canSave() {
    return Boolean(
      this._admin() && this._saveStatus &&
        this._statusEntity === this._entity && this._draft &&
        !this._operationLocked() && !this._pointFormDirty() &&
        !this._confirmDiscard && !this._confirmPointCancel &&
        this._saveStatus.state !== "recovery_required" &&
        this._draftEntity === this._entity &&
        !draftBlockReason(this._currentEntity(), this._draft) &&
        this._draft.slots.some((slot) => slot.occupied) &&
        draftChanges(this._draft).length,
    );
  }

  _saveButton() {
    return `<button class="action primary" type="button" data-action="save" ${
      this._canSave() ? "" : "disabled"
    }>Save</button>`;
  }

  _saveMessages() {
    const status = this._saveStatus;
    const errors = {
      source_changed:
        "Das Programm wurde inzwischen geändert. Bitte den Entwurf verwerfen und auf der aktuellen Grundlage neu bearbeiten.",
      program_changed:
        "own 1 ist nicht mehr aktiv. Es wird nichts weiter geschrieben.",
      backup_failed:
        "Die Sicherung konnte nicht zuverlässig gespeichert werden.",
      backup_invalid:
        "Die Sicherung ist ungültig. Eine automatische Wiederherstellung ist gesperrt.",
      recovery_conflict:
        "Das Programm wurde seit dem Fehler anderweitig geändert. Die Wiederherstellung ist zum Schutz dieser Änderungen gesperrt.",
      interrupted:
        "Der Vorgang wurde unterbrochen. Die Sicherung ist erhalten.",
      write_failed:
        "Die Übertragung ist fehlgeschlagen. Einzelne Änderungen können bereits übernommen worden sein.",
      verification_failed:
        "Das gelesene Programm stimmt nicht vollständig mit dem gewünschten Stand überein.",
      read_failed:
        "Das Ergebnis konnte nicht vollständig gelesen und geprüft werden.",
      restore_failed:
        "Die Wiederherstellung konnte nicht bestätigt werden. Die Sicherung bleibt erhalten.",
    };
    let text = this._saveNotice ?? "";
    if (this._operationLocked()) {
      text = `Speicherung läuft oder wird geprüft · ${status?.completed ?? 0}/${
        status?.total ?? 0
      } Slots übertragen. Bei Verbindungsabbruch läuft der Vorgang in Home Assistant weiter. Nicht anderweitig bearbeiten.`;
    } else if (this._saveNotice) text = this._saveNotice;
    else if (status?.state === "succeeded") {
      text = "Gespeichert und vollständig geprüft.";
    } else if (status?.state === "rolled_back") {
      text =
        "Der vorherige Stand wurde wiederhergestellt und vollständig geprüft. Ein vorhandener Entwurf bleibt lokal erhalten.";
    } else if (["recovery_required", "rejected"].includes(status?.state)) {
      text = errors[status.error] ??
        "Der Vorgang konnte nicht abgeschlossen werden. Bitte den aktuellen Stand prüfen.";
    }
    return `${
      text ? `<p class="notice" role="status">${escapeHtml(text)}</p>` : ""
    }
      ${
      status?.can_restore && this._admin() && !this._operationLocked() &&
        !this._confirmRestore
        ? '<button class="action" type="button" data-action="restore">Vorherigen Stand wiederherstellen …</button>'
        : ""
    }
      ${
      this._confirmRestore
        ? '<p class="notice" role="alert">Den gesicherten Stand vor dem Speichern an die Heizung zurückschreiben? Die Sicherung bleibt bei einem Fehler erhalten.</p><div class="toolbar"><button class="action primary" type="button" data-action="confirm-restore">Ja, wiederherstellen</button><button class="action" type="button" data-action="cancel-restore">Jetzt nicht</button></div>'
        : ""
    }
      ${
      this._confirmSave
        ? `<p class="notice" role="alert">${
          draftChanges(this._draft).length
        } geänderte Slots aus dem gesamten Wochenentwurf jetzt an die Heizung übertragen?</p><div class="toolbar"><button class="action primary" type="button" data-action="confirm-save">Jetzt speichern</button><button class="action" type="button" data-action="cancel-save">Weiter bearbeiten</button></div>`
        : ""
    }`;
  }

  _acceptSaveStatus(status) {
    this._saveStatus = status;
    if (this._uncertain && status.request_id === this._saveRequestId) {
      this._saveNotice = null;
    }
    this._uncertain = false;
    if (!status.busy && status.request_id === this._saveRequestId) {
      this._saving = false;
      if (status.state === "succeeded") this._clearDraft();
    }
    this._render();
  }

  _scheduleStatusCheck() {
    clearTimeout(this._saveTimer);
    if ((this._operationLocked()) && this.isConnected) {
      this._saveTimer = setTimeout(() => void this._refreshSaveStatus(), 2000);
    }
  }

  async _refreshSaveStatus() {
    if (!this._admin() || !this._entity || this._statusLoading) return;
    const entity = this._entity;
    this._statusLoading = true;
    try {
      const status = await this._hass.callWS({
        type: "buderus_rc30/save_status",
        entity_id: entity,
      });
      if (entity !== this._entity) return;
      this._statusEntity = entity;
      if (!this._uncertain) this._saveNotice = null;
      this._acceptSaveStatus(status);
    } catch {
      this._statusEntity = null;
      this._saveNotice =
        "Speicherstatus nicht erreichbar. Bitte Verbindung und installierte Integrationsversion prüfen.";
      this._render();
    } finally {
      this._statusLoading = false;
      this._scheduleStatusCheck();
    }
  }

  async _sendSave() {
    if (!this._canSave() || !this._confirmSave) return;
    const payload = {
      type: "buderus_rc30/save",
      entity_id: this._entity,
      request_id: crypto.randomUUID(),
      confirmed: true,
      expected_slots: structuredClone(this._draft.base.slots),
      slots: structuredClone(this._draft.slots),
    };
    this._saveRequestId = payload.request_id;
    this._confirmSave = false;
    await this._sendOperation(payload);
  }

  async _sendRestore() {
    if (
      !this._admin() || !this._confirmRestore ||
      !this._saveStatus?.can_restore || this._operationLocked()
    ) return;
    const payload = {
      type: "buderus_rc30/restore",
      entity_id: this._entity,
      request_id: this._saveStatus.request_id,
      confirmed: true,
    };
    this._confirmRestore = false;
    this._saveRequestId = payload.request_id;
    await this._sendOperation(payload);
  }

  async _sendOperation(payload) {
    this._saving = true;
    this._saveNotice = null;
    this._render();
    this._scheduleStatusCheck();
    try {
      const status = await this._hass.callWS(payload);
      this._saving = false;
      this._acceptSaveStatus(status);
    } catch {
      // A lost response never proves that the gateway remained unchanged.
      this._saving = false;
      this._uncertain = true;
      this._saveNotice =
        "Antwort fehlt. Der gespeicherte Vorgangsstatus wird abgefragt; es wird nicht erneut geschrieben.";
      await this._refreshSaveStatus();
    } finally {
      this._render();
      this._scheduleStatusCheck();
    }
  }

  _currentEntity() {
    return this._hass?.states[this._entity];
  }

  _handleAction(action, index) {
    if (this._operationLocked()) return;
    if (action === "save") {
      if (this._canSave()) this._confirmSave = true;
      this._render();
      return;
    }
    if (action === "confirm-save") {
      if (this._confirmSave && this._canSave()) void this._sendSave();
      return;
    }
    if (action === "cancel-save") {
      this._confirmSave = false;
      this._render();
      return;
    }
    if (action === "restore") {
      if (this._saveStatus?.can_restore && this._admin()) {
        this._confirmRestore = true;
      }
      this._render();
      return;
    }
    if (action === "confirm-restore") {
      if (
        this._confirmRestore && this._saveStatus?.can_restore && this._admin()
      ) void this._sendRestore();
      return;
    }
    if (action === "cancel-restore") {
      this._confirmRestore = false;
      this._render();
      return;
    }
    this._confirmSave = false;
    this._draftError = null;
    if (
      [
        "start",
        "undo",
        "day",
        "period-edit",
        "period-add",
        "period-remove",
        "preview",
      ].includes(action) &&
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
    } else if (action === "preview") {
      this._dialogDay = null;
      this._pointForm = null;
    } else {
      try {
        const blocked = draftBlockReason(this._currentEntity(), this._draft);
        if (blocked && !(action === "day" && this._draft)) {
          throw new Error(blocked);
        }
        if ((action === "start" || action === "day") && !this._draft) {
          this._draft = createDraft(
            this._currentEntity().attributes,
            this._currentEntity().state,
          );
          this._draftEntity = this._entity;
          this._history = [];
        }
        if (this._draft && this._draftEntity === this._entity) {
          if (action === "start" || action === "day") {
            const day = action === "day" ? Number(index) : localClock(
              new Date(),
              this._hass.config?.time_zone ?? "Europe/Berlin",
            ).day;
            if (!Number.isInteger(day) || day < 0 || day > 6) {
              throw new Error("Ungültiger Tag.");
            }
            this._dialogDay = day;
            this._pointForm = null;
          } else if (
            ["period-edit", "period-add", "period-remove"].includes(action)
          ) {
            const periods = dayHeatingPeriods(this._draft, this._dialogDay);
            if (action === "period-add") {
              const attrs = draftAttributes(this._draft);
              const intervals = buildWeek(attrs, String(42 - attrs.free_slots))
                .days[this._dialogDay]?.intervals ??
                [{ start: 0, end: 1440, mode: "off" }];
              const gapIndex = index === undefined
                ? intervals.findIndex((period) => period.mode === "off")
                : Number(index);
              const gap = intervals[gapIndex];
              if (!gap || gap.mode !== "off") {
                throw new Error(
                  "Dieser Tag ist bereits vollständig mit Heizzeiten belegt.",
                );
              }
              this._pointForm = {
                kind: "period",
                periodIndex: null,
                dayIndex: this._dialogDay,
                gapIndex,
                from: formatMinute(gap.start),
                to: formatMinute(gap.end),
              };
            } else {
              const period = periods[Number(index)];
              if (!period) throw new Error("Zeitraum nicht gefunden.");
              this._pointForm = {
                kind: action === "period-remove" ? "delete-period" : "period",
                periodIndex: Number(index),
                dayIndex: this._dialogDay,
                from: formatMinute(period.start),
                to: formatMinute(period.end),
                originalFrom: formatMinute(period.start),
                originalTo: formatMinute(period.end),
              };
            }
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
    if (next === this._draft) return;
    this._history.push(this._draft);
    if (this._history.length > 42) this._history.shift();
    this._draft = next;
  }

  _clearDraft() {
    this._draft = null;
    this._confirmSave = false;
    this._pointForm = null;
    this._history = [];
    this._confirmDiscard = false;
    this._draftError = null;
    this._confirmPointCancel = false;
    this._pendingAction = null;
    this._dialogDay = null;
  }

  _pointFormDirty() {
    if (!this._pointForm) return false;
    if (this._pointForm.kind === "delete-period") return true;
    if (this._pointForm.kind === "period") {
      return this._pointForm.periodIndex === null ||
        this._pointForm.from !== this._pointForm.originalFrom ||
        this._pointForm.to !== this._pointForm.originalTo;
    }
    return false;
  }

  _hasUnsavedChanges() {
    return Boolean(
      this._draft &&
        (draftChanges(this._draft).length || this._pointFormDirty()),
    );
  }

  _applyPoint() {
    if (this._operationLocked()) return;
    this._confirmSave = false;
    try {
      if (
        !this._draft || !this._pointForm || this._draftEntity !== this._entity
      ) return;
      const blocked = draftBlockReason(this._currentEntity(), this._draft);
      if (blocked) throw new Error(blocked);
      if (!["period", "delete-period"].includes(this._pointForm.kind)) {
        throw new Error("Ungültige Zeitraum-Eingabe.");
      }
      this._remember(changeDraftPeriod(
        this._draft,
        this._pointForm.dayIndex,
        this._pointForm.periodIndex,
        this._pointForm.kind === "delete-period" ? null : this._pointForm.from,
        this._pointForm.kind === "delete-period" ? null : this._pointForm.to,
      ));
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

  _draftMessages() {
    return `${
      this._draft && !this._draft.slots.some((slot) => slot.occupied)
        ? '<p class="notice">Ein vollständig leeres Programm wird nicht übertragen, da dessen Heizverhalten nicht eindeutig ist. Bitte mindestens einen Schaltpunkt beibehalten.</p>'
        : ""
    }${
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
      ${
      this._confirmPointCancel
        ? `<p class="notice" role="alert">Diese Eingabe wurde noch nicht mit Apply bestätigt. Eingabe verwerfen?</p><div class="toolbar"><button class="action" type="button" data-action="discard-point">Eingabe verwerfen</button><button class="action" type="button" data-action="keep-point">Weiter bearbeiten</button></div>`
        : ""
    }`;
  }

  _draftPanel(blocked) {
    const changes = draftChanges(this._draft);
    return `<section class="draft-area" aria-label="Schaltzeitenentwurf">
      <p class="hint">Tagesbalken anklicken, um Heizzeiten im Tagesdialog zu bearbeiten. Apply ändert nur den Entwurf.</p>
      ${
      blocked
        ? `<p class="notice" role="status">${escapeHtml(blocked)}</p>`
        : ""
    }
      ${this._dialogDay === null ? this._draftMessages() : ""}
      <details data-changes ${
      this._changesOpen ? "open" : ""
    }><summary>Ungespeicherte Änderungen · ${changes.length}</summary>
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
      </details>
      <div class="toolbar"><button class="action" type="button" data-action="start">Tag bearbeiten</button>
        <button class="action" type="button" data-action="undo" ${
      blocked || !this._history.length ? "disabled" : ""
    }>Rückgängig</button>
        <button class="action" type="button" data-action="discard">Cancel</button>
        ${this._saveButton()}</div>
      <p class="hint">Apply ändert nur den Entwurf. Save überträgt alle bestätigten Änderungen gemeinsam an die Heizung. Schreiben ist nur als Administrator möglich.</p>
    </section>`;
  }

  _dayDialogMarkup(blocked) {
    const day = this._dialogDay;
    const attrs = draftAttributes(this._draft);
    const week = buildWeek(attrs, String(42 - attrs.free_slots));
    const intervals = week.days[day]?.intervals ??
      [{ start: 0, end: 1440, mode: "off" }];
    const periods = dayHeatingPeriods(this._draft, day);
    const baseDraft = { ...this._draft, slots: this._draft.base.slots };
    const clock = localClock(
      new Date(),
      this._hass.config?.time_zone ?? "Europe/Berlin",
    );
    const disabled = blocked || this._confirmDiscard || this._confirmPointCancel
      ? "disabled"
      : "";
    const dirtyDays = DAYS.map((_, index) =>
      JSON.stringify(dayHeatingPeriods(baseDraft, index)) !==
        JSON.stringify(dayHeatingPeriods(this._draft, index))
    );
    let heatingIndex = -1;
    const rows = intervals.map((interval, intervalIndex) => {
      // Merge consecutive on transitions into a single editable heating range.
      if (interval.mode === "on") {
        const periodIndex = periods.findIndex((period) =>
          period.start <= interval.start && period.end >= interval.end
        );
        if (periodIndex === heatingIndex) return "";
        heatingIndex = periodIndex;
        const period = periods[periodIndex];
        if (
          this._pointForm?.dayIndex === day &&
          this._pointForm.periodIndex === periodIndex &&
          ["period", "delete-period"].includes(this._pointForm.kind)
        ) return this._periodFormMarkup(disabled);
        return `<button class="period-row" type="button" data-action="period-edit" data-index="${periodIndex}" ${disabled} aria-label="Heizzeit ${
          formatMinute(period.start)
        } bis ${formatMinute(period.end)} bearbeiten"><span>${
          formatMinute(period.start)
        } – ${
          formatMinute(period.end)
        }</span><span class="phase on">Heizzeit · Bearbeiten</span></button>`;
      }
      if (
        this._pointForm?.dayIndex === day &&
        this._pointForm.periodIndex === null &&
        this._pointForm.gapIndex === intervalIndex
      ) return this._periodFormMarkup(disabled);
      return `<button class="period-row" type="button" data-action="period-add" data-index="${intervalIndex}" ${disabled} aria-label="Heizzeit im Bereich ${
        formatMinute(interval.start)
      } bis ${formatMinute(interval.end)} hinzufügen"><span>${
        formatMinute(interval.start)
      } – ${
        formatMinute(interval.end)
      }</span><span class="phase">Absenkzeit · + Heizzeit</span></button>`;
    }).join("");
    return `<dialog class="day-dialog" aria-labelledby="rc30-day-title"><div class="dialog-shell">
      <header class="dialog-header"><h2 id="rc30-day-title">${
      LABELS[day]
    } · Heizzeiten</h2><button class="action" type="button" data-action="discard" aria-label="Editor schließen">✕</button></header>
      <div class="dialog-body"><div class="day-tabs" aria-label="Wochentag">${
      DAYS.map((_, index) =>
        `<button class="action day-tab" type="button" data-action="day" data-index="${index}" aria-pressed="${
          day === index
        }" aria-label="${LABELS[index]}${
          dirtyDays[index] ? ", ungespeicherte Änderungen" : ""
        }">${LABELS[index].slice(0, 2)}${dirtyDays[index] ? " •" : ""}</button>`
      ).join("")
    }</div>
        <p class="hint">Entwurf · own 1 · ${
      42 - attrs.free_slots
    }/42 Slots belegt. Änderungen werden noch nicht an die Heizung übertragen.</p>
        ${
      blocked
        ? `<p class="notice" role="status">${escapeHtml(blocked)}</p>`
        : ""
    }
        <div class="dialog-status">Aktuelle Uhrzeit: ${
      formatMinute(clock.minute)
    }</div>
        <div class="scale" style="margin-left:0" aria-hidden="true">${
      [0, 6, 12, 18, 24].map((hour) =>
        `<span class="tick" style="left:${hour / 24 * 100}%">${
          String(hour).padStart(2, "0")
        }</span>`
      ).join("")
    }</div>
        <div class="dialog-track" aria-label="Tagesvorschau">${
      periods.map((period, index) =>
        `<button type="button" class="segment" data-action="period-edit" data-index="${index}" ${disabled} style="left:${
          period.start / DAY_MINUTES * 100
        }%;width:${
          (period.end - period.start) / DAY_MINUTES * 100
        }%" aria-label="Heizzeit ${formatMinute(period.start)} bis ${
          formatMinute(period.end)
        } bearbeiten"></button>`
      ).join("")
    }<span class="now" style="left:${
      Math.min(clock.minute / DAY_MINUTES * 100, 99.8)
    }%" aria-hidden="true"></span></div>
        ${this._draftMessages()}
        ${this._saveMessages()}
        ${
      !week.days.length
        ? '<p class="notice">Noch keine Schaltpunkte vorhanden. Du kannst eine erste Heizzeit als Entwurf anlegen.</p>'
        : ""
    }
        ${rows}
        <div class="toolbar"><button class="action primary" type="button" data-action="period-add" ${
      blocked || !intervals.some((interval) => interval.mode === "off")
        ? "disabled"
        : ""
    }>+ Heizzeit</button><button class="action" type="button" data-action="undo" ${
      blocked || !this._history.length ? "disabled" : ""
    }>Rückgängig</button></div>
      </div><footer class="dialog-footer"><div class="toolbar"><button class="action" type="button" data-action="preview">Wochenvorschau</button><button class="action" type="button" data-action="discard">Cancel</button>${this._saveButton()}</div><p class="dialog-status">Apply bestätigt den Entwurf. Save überträgt ihn an die Heizung.</p></footer>
    </div></dialog>`;
  }

  _periodFormMarkup(disabled) {
    const point = this._pointForm;
    if (point.kind === "delete-period") {
      return `<form class="point-form period-form"><h3>Heizzeit entfernen?</h3><p>${point.from} – ${point.to}</p><div class="toolbar"><button class="action primary" type="submit" ${disabled}>Apply</button><button class="action" type="button" data-action="cancel-point">Cancel</button></div></form>`;
    }
    return `<form class="point-form period-form"><h3>${
      point.periodIndex === null ? "Neue Heizzeit" : "Heizzeit ändern"
    }</h3><div class="fields"><label>Von<input type="text" inputmode="numeric" maxlength="5" data-point-field="from" value="${
      escapeHtml(point.from)
    }" required ${disabled}></label><label>Bis<input type="text" inputmode="numeric" maxlength="5" data-point-field="to" value="${
      escapeHtml(point.to)
    }" required ${disabled}></label></div><p class="hint">10-Minuten-Schritte · Ende bis 24:00</p><div class="toolbar"><button class="action primary" type="submit" ${disabled}>Apply</button><button class="action" type="button" data-action="cancel-point">Cancel</button>${
      point.periodIndex !== null
        ? `<button class="action" type="button" data-action="period-remove" data-index="${point.periodIndex}" ${disabled}>− Heizzeit</button>`
        : ""
    }</div></form>`;
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
            aria-label="${LABELS[index]}: ${readable}. Tag bearbeiten.">
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
          </div>`;
      }).join("")
    }
      <p class="hint">Tagesbalken antippen zum Bearbeiten. Angezeigt werden die programmierten Heiz- und Absenkzeiten.</p>`;
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
