// CONFIG
const CHARS_PER_TOKEN = 4; // Approx GPT English average

// UTIL: Estimate Tokens
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// STORE TOKENS
function storeTokens(promptTokens = 0, responseTokens = 0) {
    chrome.storage.local.get(
        ['totalTokens', 'promptTokens', 'responseTokens'],
        (res) => {

            const newPrompt = (res.promptTokens || 0) + promptTokens;
            const newResponse = (res.responseTokens || 0) + responseTokens;
            const newTotal = newPrompt + newResponse;

            chrome.storage.local.set({
                promptTokens: newPrompt,
                responseTokens: newResponse,
                totalTokens: newTotal
            });
        }
    );
}

// Capture User Prompt
function capturePrompt() {
    const textarea =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"]');

    if (!textarea) return;

    const text = textarea.value || textarea.innerText || "";
    if (!text.trim()) return;

    const tokens = estimateTokens(text);
    storeTokens(tokens, 0);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        capturePrompt();
    }
}, true);

document.addEventListener('click', (e) => {
    if (e.target.closest('button[data-testid*="send"], button[aria-label*="Send"]')) {
        capturePrompt();
    }
}, true);


// Capture Assistant Responses
const processedMessages = new WeakSet();

function processAssistantMessages() {
    const messages = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
    );

    messages.forEach(msg => {
        if (processedMessages.has(msg)) return;

        const text = msg.innerText || "";
        if (!text.trim()) return;

        const tokens = estimateTokens(text);
        storeTokens(0, tokens);

        processedMessages.add(msg);
    });
}

const observer = new MutationObserver(() => {
    processAssistantMessages();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Initial check (in case page already loaded)
processAssistantMessages();
