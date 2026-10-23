(function () {
  const S =
    typeof module !== "undefined"
      ? require("./shared.js")
      : globalThis.EcoPrompt;
  const PERIODS = { today: "Today", week: "Last 7 days", all: "All time" };
  function selectUsage(state, period, now = new Date()) {
    if (period === "all")
      return {
        prompt: state.promptTokens,
        response: state.responseTokens,
        total: state.totalTokens,
        platforms: state.platforms,
      };
    const days = period === "today" ? [S.dateKey(now)] : S.recentDays(7, now);
    const selected = { prompt: 0, response: 0, total: 0, platforms: {} };
    for (const key of days) {
      const day = state.dailyHistory[key];
      if (!day) continue;
      for (const metric of ["prompt", "response", "total"])
        selected[metric] += day[metric];
      for (const [host, value] of Object.entries(day.platforms || {})) {
        const entry = (selected.platforms[host] ||= {
          prompt: 0,
          response: 0,
          total: 0,
        });
        for (const metric of ["prompt", "response", "total"])
          entry[metric] += value[metric];
      }
    }
    return selected;
  }
  function quantity(value, base, large) {
    const scaled = value >= 1000;
    const number = scaled ? value / 1000 : value;
    const text =
      number === 0
        ? "0"
        : number < 0.01
          ? "<0.01"
          : new Intl.NumberFormat(undefined, {
              maximumSignificantDigits: 2,
            }).format(number);
    return { value: text, unit: scaled ? large : base };
  }
  function duration(seconds) {
    if (seconds < 1) return "less than a second";
    if (seconds < 60) return `about ${Math.round(seconds)} seconds`;
    if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
    return `about ${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 }).format(seconds / 3600)} hours`;
  }
  function exportData(state, now = new Date()) {
    const { recentBatches, epoch, ...usage } = state;
    const cutoff = S.recentDays(30, now)[0];
    usage.dailyHistory = Object.fromEntries(
      Object.entries(usage.dailyHistory).filter(([key]) => key >= cutoff),
    );
    return {
      exportedAt: now.toISOString(),
      model: S.MODEL,
      notice:
        "Illustrative estimates, not measured consumption. Token counts approximate visible text only.",
      usage,
    };
  }
  function init(doc = document, api = chrome) {
    let state = S.normalize(),
      period = "today",
      revision = 0;
    const byId = (id) => doc.getElementById(id);
    const text = (id, value) => {
      byId(id).textContent = value;
    };
    const feedback = (value) => text("feedback", value);
    const integer = (n) => n.toLocaleString();
    async function request(message) {
      const reply = await api.runtime.sendMessage(message);
      if (!reply?.ok)
        throw new Error(
          reply?.error ||
            "Could not connect. Reload the extension and refresh your AI tabs.",
        );
      return S.normalize(reply.state);
    }
    function metric(value, id, unitId, base, large) {
      const formatted = quantity(value, base, large);
      text(id, formatted.value);
      text(unitId, formatted.unit);
    }
    function renderPlatforms(selected) {
      const container = byId("platform-bars");
      container.replaceChildren();
      const entries = Object.entries(selected.platforms)
        .filter(([, value]) => value.total > 0)
        .sort((a, b) => b[1].total - a[1].total);
      for (const [host, value] of entries) {
        const row = doc.createElement("div");
        row.className = "platform-row";
        const name = doc.createElement("span");
        name.textContent = S.PLATFORMS[host];
        const track = doc.createElement("div");
        track.className = "platform-track";
        track.setAttribute("aria-hidden", "true");
        const fill = doc.createElement("div");
        fill.className = "platform-fill";
        fill.style.width = `${(value.total / Math.max(1, selected.total)) * 100}%`;
        track.append(fill);
        const number = doc.createElement("span");
        number.className = "platform-value";
        number.textContent = new Intl.NumberFormat(undefined, {
          style: "percent",
          maximumFractionDigits: 0,
        }).format(value.total / Math.max(1, selected.total));
        number.title = `${integer(value.total)} estimated tokens`;
        row.append(name, track, number);
        container.append(row);
      }
      if (!entries.length) {
        const empty = doc.createElement("p");
        empty.className = "small";
        empty.textContent = "No platform activity in this period.";
        container.append(empty);
      }
      const assigned = entries.reduce((sum, [, value]) => sum + value.total, 0);
      byId("legacy-note").hidden = assigned >= selected.total;
    }
    function renderChart() {
      const chart = byId("daily-chart");
      // Keep keyboard focus and the chosen day intact during live storage updates.
      const focusedDate = doc.activeElement?.dataset.date;
      const selectedDate = chart.querySelector('[aria-pressed="true"]')?.dataset
        .date;
      chart.replaceChildren();
      const days = S.recentDays();
      const max = Math.max(
        1,
        ...days.map((key) => state.dailyHistory[key]?.total || 0),
      );
      for (const key of days) {
        const tokens = state.dailyHistory[key]?.total || 0;
        const date = new Date(`${key}T12:00:00`);
        const amount = quantity(S.estimate(tokens).wh, "Wh", "kWh");
        const label = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${amount.value} ${amount.unit}, ${integer(tokens)} estimated tokens`;
        const button = doc.createElement("button");
        button.className = "day";
        button.type = "button";
        button.dataset.date = key;
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(key === selectedDate));
        button.title = label;
        const track = doc.createElement("span");
        track.className = "day-track";
        track.setAttribute("aria-hidden", "true");
        const bar = doc.createElement("span");
        bar.className = "day-bar";
        bar.style.height = `${Math.max(2, (tokens / max) * 64)}px`;
        track.append(bar);
        const caption = doc.createElement("span");
        caption.textContent =
          key === S.dateKey()
            ? "Today"
            : date.toLocaleDateString(undefined, { weekday: "short" });
        button.append(track, caption);
        button.addEventListener("click", () => {
          chart
            .querySelectorAll("button")
            .forEach((item) =>
              item.setAttribute("aria-pressed", String(item === button)),
            );
          text("chart-readout", label);
        });
        chart.append(button);
        if (key === selectedDate) text("chart-readout", label);
      }
      if (focusedDate)
        chart.querySelector(`[data-date="${focusedDate}"]`)?.focus();
    }
    function render() {
      const selected = selectUsage(state, period),
        impact = S.estimate(selected.total);
      metric(impact.wh, "energy-val", "energy-unit", "Wh", "kWh");
      metric(impact.ml, "water-val", "water-unit", "mL", "L");
      metric(impact.grams, "co2-val", "co2-unit", "g CO₂e", "kg CO₂e");
      text(
        "impact-label",
        `Illustrative energy estimate · ${PERIODS[period].toLowerCase()}`,
      );
      text(
        "equivalent",
        selected.total
          ? `Like a 9 W LED on for ${duration(impact.bulbSeconds)}.`
          : "A small number. A useful perspective.",
      );
      text("input-count", integer(selected.prompt));
      text("output-count", integer(selected.response));
      text("token-count", integer(selected.total));
      text(
        "token-summary",
        `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(selected.total)} tokens`,
      );
      text("platform-period", PERIODS[period]);
      byId("empty-state").hidden = selected.total > 0;
      text(
        "empty-title",
        state.paused
          ? "Take a pause. Your totals will wait."
          : state.totalTokens
            ? "A fresh start for this period."
            : "Your next prompt is a starting point.",
      );
      text(
        "empty-copy",
        state.paused
          ? "Resume tracking when you’re ready. Activity while paused is excluded."
          : "Open ChatGPT, Gemini, or Claude and send a message. New text exchanges appear here automatically.",
      );
      byId("pause-btn").textContent = state.paused ? "Resume" : "Pause";
      byId("tracking-status").lastChild.textContent = state.paused
        ? " Tracking paused"
        : " Tracking new text exchanges";
      doc.body.classList.toggle("paused", state.paused);
      renderPlatforms(selected);
      renderChart();
    }
    async function refresh() {
      const current = ++revision;
      try {
        const next = await request({ type: "GET_STATE" });
        if (current === revision) {
          state = next;
          render();
        }
      } catch (error) {
        feedback(error.message);
      }
    }
    doc.querySelectorAll("[data-period]").forEach((button) =>
      button.addEventListener("click", () => {
        period = button.dataset.period;
        doc
          .querySelectorAll("[data-period]")
          .forEach((item) =>
            item.setAttribute("aria-pressed", String(item === button)),
          );
        render();
      }),
    );
    byId("pause-btn").addEventListener("click", async () => {
      byId("pause-btn").disabled = true;
      try {
        state = await request({ type: "SET_PAUSED", paused: !state.paused });
        render();
        feedback(
          state.paused
            ? "Tracking paused across all tabs."
            : "Tracking resumed. Send a new message to continue.",
        );
      } catch (error) {
        feedback(error.message);
      } finally {
        byId("pause-btn").disabled = false;
      }
    });
    byId("reset-btn").addEventListener("click", () => {
      byId("reset-confirm").hidden = false;
      byId("confirm-reset-btn").focus();
    });
    byId("cancel-reset-btn").addEventListener("click", () => {
      byId("reset-confirm").hidden = true;
      byId("reset-btn").focus();
    });
    byId("confirm-reset-btn").addEventListener("click", async () => {
      byId("confirm-reset-btn").disabled = true;
      try {
        state = await request({ type: "RESET" });
        render();
        byId("reset-confirm").hidden = true;
        text("chart-readout", "Select a day for its estimate.");
        feedback(
          "All usage data cleared. New exchanges will start a fresh record.",
        );
        byId("reset-btn").focus();
      } catch (error) {
        feedback(error.message);
      } finally {
        byId("confirm-reset-btn").disabled = false;
      }
    });
    byId("export-btn").addEventListener("click", async () => {
      try {
        const latest = await request({ type: "GET_STATE" });
        const blob = new Blob([JSON.stringify(exportData(latest), null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob),
          anchor = doc.createElement("a");
        anchor.href = url;
        anchor.download = `ecoprompt-${S.dateKey()}.json`;
        doc.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        feedback("Export downloaded, including the estimation assumptions.");
      } catch (error) {
        feedback(error.message);
      }
    });
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local") refresh();
    });
    text("version", `v${api.runtime.getManifest().version}`);
    refresh();
    return { refresh };
  }
  if (typeof module !== "undefined")
    module.exports = { selectUsage, quantity, duration, exportData, init };
  else
    document.addEventListener("DOMContentLoaded", () => init(), { once: true });
})();
