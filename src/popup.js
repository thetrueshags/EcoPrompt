// ── Constants ────────────────────────────────────────────────────────────────

const WH_PER_TOKEN = 0.0005;
const ML_PER_TOKEN = 0.002;
const BULB_WATTS = 9;
const GCO2_PER_KWH = 450;   // global average grid intensity
const GCO2_PER_TOKEN = WH_PER_TOKEN / 1000 * GCO2_PER_KWH; // 0.000225

const PLATFORM_COLORS = {
    "claude.ai": "#d97706",
    "chatgpt.com": "#10b981",
    "gemini.google.com": "#3b82f6",
};

const PLATFORM_LABELS = {
    "claude.ai": "Claude",
    "chatgpt.com": "ChatGPT",
    "gemini.google.com": "Gemini",
};

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    updateUI();

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") {
            updateUI();
        }
    });

    document.getElementById('reset-btn').addEventListener('click', () => {
        chrome.storage.local.set({
            totalTokens: 0,
            promptTokens: 0,
            responseTokens: 0,
            platforms: {},
        }, updateUI);
    });

    document.getElementById('export-btn').addEventListener('click', () => {
        chrome.storage.local.get(null, (data) => {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = "ecoprompt-export-" + new Date().toISOString().slice(0, 10) + ".json";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });
    });

    document.getElementById('disclaimer-toggle').addEventListener('click', () => {
        const text = document.getElementById('disclaimer-text');
        const chevron = document.getElementById('chevron');
        const isOpen = text.style.display === 'block';
        text.style.display = isOpen ? 'none' : 'block';
        chevron.innerHTML = isOpen ? '&#9662;' : '&#9652;';
    });
});

// ── Animation ────────────────────────────────────────────────────────────────

function animateNumber(el, target, decimals) {
    if (decimals === undefined) decimals = 0;
    if (!el) return;

    var startStr = el.innerText;
    var start = parseFloat((startStr || "0").replace(/,/g, "")) || 0;
    var duration = 600;
    var startTime = performance.now();

    function step(now) {
        var progress = Math.min((now - startTime) / duration, 1);
        var current = start + (target - start) * progress;
        el.innerText = current.toFixed(decimals);
        if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

// ── UI Update ────────────────────────────────────────────────────────────────

function updateUI() {
    chrome.storage.local.get(
        ['totalTokens', 'promptTokens', 'responseTokens', 'platforms', 'dailyHistory'],
        function (res) {
            var tokens = res.totalTokens || 0;
            var prompt = res.promptTokens || 0;
            var response = res.responseTokens || 0;
            var platforms = res.platforms || {};
            var dailyHistory = res.dailyHistory || {};

            var energyWh = tokens * WH_PER_TOKEN;
            var waterMl = tokens * ML_PER_TOKEN;
            var bulbMins = (energyWh / BULB_WATTS) * 60;
            var co2Grams = tokens * GCO2_PER_TOKEN;

            // ── Bulb time ──
            var bulbEl = document.getElementById('bulb-time');
            if (bulbEl) {
                var timeStr = "0 mins";
                if (tokens > 0) {
                    if (bulbMins < 1)
                        timeStr = Math.round(bulbMins * 60) + " seconds";
                    else if (bulbMins > 60)
                        timeStr = (bulbMins / 60).toFixed(1) + " hours";
                    else
                        timeStr = Math.round(bulbMins) + " mins";
                }
                bulbEl.innerText = timeStr;
            }

            // ── Energy ──
            animateNumber(document.getElementById('energy-val'), energyWh, 3);

            // ── Water ──
            var waterEl = document.getElementById('water-val');
            if (waterEl) {
                if (waterMl >= 1000) {
                    animateNumber(waterEl, waterMl / 1000, 2);
                    document.getElementById('water-unit').innerText = "Liters evaporated (estimated)";
                } else {
                    animateNumber(waterEl, waterMl, 1);
                    document.getElementById('water-unit').innerText = "ml evaporated (estimated)";
                }
            }

            // ── CO₂ ──
            var co2El = document.getElementById('co2-val');
            if (co2El) {
                if (co2Grams >= 1000) {
                    animateNumber(co2El, co2Grams / 1000, 2);
                    document.getElementById('co2-unit').innerText = "kg CO₂ (estimated)";
                } else {
                    animateNumber(co2El, co2Grams, 1);
                    document.getElementById('co2-unit').innerText = "g CO₂ (estimated)";
                }
            }

            // ── Token counts ──
            var tokenEl = document.getElementById('token-count');
            if (tokenEl) tokenEl.innerText = Math.floor(tokens).toLocaleString();

            var inputCountEl = document.getElementById('input-count');
            if (inputCountEl) inputCountEl.innerText = Math.floor(prompt).toLocaleString();

            var outputCountEl = document.getElementById('output-count');
            if (outputCountEl) outputCountEl.innerText = Math.floor(response).toLocaleString();

            // ── Per-platform breakdown ──
            renderPlatforms(platforms);

            // ── 7-day chart ──
            renderDailyChart(dailyHistory);
        }
    );
}

// ── Platform Breakdown ───────────────────────────────────────────────────────

function renderPlatforms(platforms) {
    var container = document.getElementById('platform-bars');
    var section = document.getElementById('platform-section');
    if (!container || !section) return;

    var entries = Object.entries(platforms).filter(function (e) { return e[1].total > 0; });
    if (entries.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    var maxTotal = Math.max.apply(null, entries.map(function (e) { return e[1].total; }));
    container.innerHTML = '';

    entries
        .sort(function (a, b) { return b[1].total - a[1].total; })
        .forEach(function (entry) {
            var key = entry[0], val = entry[1];
            var pct = maxTotal > 0 ? (val.total / maxTotal) * 100 : 0;
            var color = PLATFORM_COLORS[key] || '#6b7280';
            var label = PLATFORM_LABELS[key] || key;

            var row = document.createElement('div');
            row.className = 'platform-row';
            row.innerHTML =
                '<span class="platform-dot" style="background:' + color + '"></span>' +
                '<span class="platform-name">' + label + '</span>' +
                '<div class="platform-bar-track"><div class="platform-bar" style="width:' + pct + '%;background:' + color + '"></div></div>' +
                '<span class="platform-count">' + formatCompact(val.total) + '</span>';
            container.appendChild(row);
        });
}

// ── Daily Chart ──────────────────────────────────────────────────────────────

function renderDailyChart(dailyHistory) {
    var chartEl = document.getElementById('daily-chart');
    var labelsEl = document.getElementById('chart-labels');
    if (!chartEl || !labelsEl) return;

    var days = getLast7Days();
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    var data = days.map(function (dateStr) {
        var entry = dailyHistory[dateStr] || { prompt: 0, response: 0, total: 0 };
        return { date: dateStr, prompt: entry.prompt, response: entry.response, total: entry.total };
    });

    var maxTotal = Math.max(1, Math.max.apply(null, data.map(function (d) { return d.total; })));

    chartEl.innerHTML = '';
    labelsEl.innerHTML = '';

    data.forEach(function (d) {
        var col = document.createElement('div');
        col.className = 'chart-col';

        var pHeight = Math.max(0, (d.prompt / maxTotal) * 36);
        var rHeight = Math.max(0, (d.response / maxTotal) * 36);

        var pBar = document.createElement('div');
        pBar.className = 'chart-bar prompt';
        pBar.style.height = pHeight + 'px';
        pBar.title = 'Input: ' + formatCompact(d.prompt);

        var rBar = document.createElement('div');
        rBar.className = 'chart-bar response';
        rBar.style.height = rHeight + 'px';
        rBar.title = 'Output: ' + formatCompact(d.response);

        col.appendChild(pBar);
        col.appendChild(rBar);
        chartEl.appendChild(col);

        var label = document.createElement('div');
        label.className = 'chart-label';
        var dateObj = new Date(d.date + 'T12:00:00');
        label.textContent = dayNames[dateObj.getDay()];
        labelsEl.appendChild(label);
    });
}

function getLast7Days() {
    var days = [];
    for (var i = 6; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var key = d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
        days.push(key);
    }
    return days;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.floor(n));
}
