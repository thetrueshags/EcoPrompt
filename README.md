# EcoPrompt

Track your AI usage and explore its estimated environmental footprint.

EcoPrompt is a Chrome extension for ChatGPT, Gemini, and Claude. It estimates the tokens in new text exchanges and translates them into illustrative energy, water, and carbon figures, with a comparison to the time that energy could power an LED lightbulb.

**[Install EcoPrompt from the Chrome Web Store](https://chromewebstore.google.com/detail/ecoprompt-ai-usage-footpr/glhfflceejioklhefnglbnokjnldmddj)**

## Getting started

1. Install the extension from the Chrome Web Store.
2. Refresh any open ChatGPT, Gemini, or Claude tabs.
3. Let the page finish loading, then send a new message.
4. Open EcoPrompt from the Chrome toolbar to see your usage.

Tracking runs automatically on supported websites. Existing conversation history is excluded, so opening an old chat does not add its previous messages to your totals.

## Features

- Separate estimates for input and output tokens, including streamed responses.
- A breakdown of usage across ChatGPT, Gemini, and Claude.
- A daily activity chart covering the last seven days.
- Illustrative energy, water, and carbon estimates, plus an LED lightbulb comparison.
- Export of locally stored usage data as JSON.
- A reset option for cumulative totals. Daily history is retained separately.

## Privacy

EcoPrompt reads visible message text in memory to estimate usage. It stores only aggregate token counts, platform totals, and daily usage history in your browser's local extension storage. It does not save your conversation text or send it to a server.

There is no EcoPrompt account, analytics service, or external API connection. Access to the three supported websites lets the extension detect messages; the storage permission lets it save usage totals locally.

## Understanding the estimates

EcoPrompt uses a word-based approximation of token counts and fixed conversion factors:

| Measure | Assumption |
| --- | --- |
| Tokens | Word count × 1.3, rounded up per message |
| Energy | 0.0005 Wh per estimated token |
| Water | 0.002 ml per estimated token |
| Carbon | 450 g CO₂ per kWh of estimated energy |
| Lightbulb comparison | Time an equivalent amount of energy could power a 9 W LED |

These figures are intended for awareness. They are not measurements of a provider's actual resource use. Actual consumption varies with the model, hardware, workload, data centre, cooling system, and electricity supply. Word-based token estimates also vary in accuracy across languages and content types.

Tracking covers visible text in new exchanges. Hidden reasoning, reused conversation context, and image, audio, or video generation are outside the estimate.

## Local development

Clone the repository and install the development dependencies with Node.js and npm:

```sh
git clone https://github.com/thetrueshags/EcoPrompt.git
cd EcoPrompt
npm ci
```

To load the extension locally:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the **src** folder, which contains the extension manifest.
4. Refresh your supported AI tabs and send a new message after the page finishes loading.

After making changes, click **Reload** on the extension's card and refresh the relevant tabs again.

Run the test suite with:

```sh
npm test
```

## Contributing

Bug reports and pull requests are welcome, especially for changes to supported platforms' message layouts, tracking accuracy, and the assumptions behind the environmental estimates. For tracking issues, include the platform, browser version, and steps to reproduce. Use a short sample conversation rather than sharing private chat content.

## License

EcoPrompt is available under the [MIT License](LICENSE).
