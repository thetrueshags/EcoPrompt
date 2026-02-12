# EcoPrompt: AI Climate Impact Tracker 🌍💧

**EcoPrompt** is a lightweight Chrome extension that makes the "invisible" environmental cost of AI tangible. By tracking your interactions with platforms like ChatGPT and Gemini, it calculates real-time estimates of water consumption and energy usage to promote more conscious prompting.

## 🚀 The Mission

Modern AI models are incredibly efficient, but their scale means every prompt counts. EcoPrompt doesn't aim to stop you from using AI; it aims to give you **consciousness** of your digital footprint.

## ✨ Features

* **Automatic Tracking:** Works silently in the background on ChatGPT, Gemini, and Claude.
* **Modern Efficiency Math:** Uses 2025/2026 inference benchmarks to ensure data is realistic (not exaggerated).
* **Human-Scale Metrics:** Converts abstract Watt-hours (Wh) into relatable units, like how long you could power an LED lightbulb.
* **Privacy First:** No text or data ever leaves your browser. All calculations happen locally.

## 🛠️ Installation (Developer Mode)

Since this is currently a "tiny" project, you can load it as an unpacked extension:

1. **Clone/Download** this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer Mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the project folder.

## 📊 The Math Behind the Estimates

To maintain accuracy and avoid "fear-mongering" with outdated stats, EcoPrompt uses the following conservative benchmarks based on 2025 inference efficiency:

| Metric | Constant | Context |
| --- | --- | --- |
| **Energy** | ~0.0005 Wh / token | Balanced for GPT-4o / Gemini Pro models. |
| **Water** | ~0.002 ml / token | Accounts for data center evaporative cooling. |
| **Lightbulb** | 9W LED Standard | Energy / 9W * 60 minutes. |

> [!IMPORTANT]
> **Disclaimer:** These values are estimates designed for awareness. Real-world impact varies heavily based on model architecture, data center Power Usage Effectiveness (PUE), and the local energy grid.

## 📂 Project Structure

```text
.
├── manifest.json    # Extension configuration
├── content.js       # Background script for message detection
├── popup.html       # The dashboard UI
├── popup.js         # UI logic and math engine
└── icons/           # Extension icons

```

## 🤝 Contributing

Contributions keeping up with ChatGPT/Gemini UI updates and refined math models are highly welcome.