document.addEventListener('DOMContentLoaded', () => {
    updateUI();

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && (changes.totalTokens || changes.promptTokens || changes.responseTokens)) {
            updateUI();
        }
    });

    document.getElementById('reset-btn').addEventListener('click', () => {
        chrome.storage.local.set({
            totalTokens: 0,
            promptTokens: 0,
            responseTokens: 0
        }, updateUI);
    });

    document.getElementById('disclaimer-toggle').addEventListener('click', () => {
        const text = document.getElementById('disclaimer-text');
        const chevron = document.getElementById('chevron');
        const isOpen = text.style.display === 'block';
        text.style.display = isOpen ? 'none' : 'block';
        chevron.innerHTML = isOpen ? '&#9662;' : '&#9652;';
    });
});

function animateNumber(el, target, decimals = 0) {
    if (!el) return;

    const start = parseFloat(el.innerText.replace(/,/g, "")) || 0;
    const duration = 600;
    const startTime = performance.now();

    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const current = start + (target - start) * progress;
        el.innerText = current.toFixed(decimals);
        if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

function updateUI() {
    chrome.storage.local.get(
        ['totalTokens', 'promptTokens', 'responseTokens'],
        (res) => {

            const tokens = res.totalTokens || 0;
            const prompt = res.promptTokens || 0;
            const response = res.responseTokens || 0;

            // Energy Model
            const WH_PER_TOKEN = 0.0005;
            const ML_PER_TOKEN = 0.002;
            const BULB_WATTS = 9;

            const energyWh = tokens * WH_PER_TOKEN;
            const waterMl = tokens * ML_PER_TOKEN;
            const bulbMins = (energyWh / BULB_WATTS) * 60;

            // Bulb Time
            const bulbEl = document.getElementById('bulb-time');
            if (bulbEl) {
                let timeStr = "0 mins";

                if (tokens > 0) {
                    if (bulbMins < 1)
                        timeStr = `${Math.round(bulbMins * 60)} seconds`;
                    else if (bulbMins > 60)
                        timeStr = `${(bulbMins / 60).toFixed(1)} hours`;
                    else
                        timeStr = `${Math.round(bulbMins)} mins`;
                }

                bulbEl.innerText = timeStr;
            }

            // Energy
            animateNumber(
                document.getElementById('energy-val'),
                energyWh,
                3
            );

            // Water
            const waterEl = document.getElementById('water-val');
            if (waterEl) {
                if (waterMl >= 1000) {
                    animateNumber(waterEl, waterMl / 1000, 2);
                    document.getElementById('water-unit').innerText =
                        "Liters evaporated (estimated)";
                } else {
                    animateNumber(waterEl, waterMl, 1);
                    document.getElementById('water-unit').innerText =
                        "ml evaporated (estimated)";
                }
            }

            // Token Count
            const tokenEl = document.getElementById('token-count');
            if (tokenEl) {
                tokenEl.innerText =
                    Math.floor(tokens).toLocaleString();
            }

            const inputCountEl = document.getElementById('input-count');
            if (inputCountEl) {
                inputCountEl.innerText = Math.floor(prompt).toLocaleString();
            }

            const outputCountEl = document.getElementById('output-count');
            if (outputCountEl) {
                outputCountEl.innerText = Math.floor(response).toLocaleString();
            }
        }
    );
}
