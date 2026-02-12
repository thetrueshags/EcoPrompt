const CONFIGS = {
    'gemini.google.com': {
        user: '.user-query',
        ai: '.model-response-text'
    },
    'chatgpt.com': {
        user: '[data-message-author-role="user"]',
        ai: '[data-message-author-role="assistant"]'
    },
    'claude.ai': {
        user: '.font-user-message',
        ai: '.font-claude-message'
    }
};

const hostname = window.location.hostname;
const currentConfig = Object.keys(CONFIGS).find(key => hostname.includes(key)) ? CONFIGS[Object.keys(CONFIGS).find(key => hostname.includes(key))] : null;

// Track AI message states for streaming: node -> lastTokenCount
const aiStreamStates = new WeakMap();
// Track User message states to ensure we capture text if it loads late
const userMessageStates = new WeakMap();

function countTokens(text) {
    if (!text) return 0;
    const words = text.trim().split(/\s+/).length;
    return Math.ceil(words * 1.3);
}

function updateStorage(type, tokenDelta) {
    if (tokenDelta <= 0) return;

    chrome.storage.local.get(['totalTokens', 'promptTokens', 'responseTokens'], (result) => {
        const currentTotal = result.totalTokens || 0;
        const currentPrompt = result.promptTokens || 0;
        const currentResponse = result.responseTokens || 0;

        const updates = {
            totalTokens: currentTotal + tokenDelta
        };

        if (type === 'prompt') {
            updates.promptTokens = currentPrompt + tokenDelta;
        } else if (type === 'response') {
            updates.responseTokens = currentResponse + tokenDelta;
        }

        chrome.storage.local.set(updates);
        console.log(`[EcoPrompt] Added ${tokenDelta} ${type} tokens.`);
    });
}

function monitorUserMessage(node) {
    if (userMessageStates.has(node)) return; // Already tracking or processed

    const checkAndLog = () => {
        const text = node.innerText;
        const tokens = countTokens(text);

        // If we found valid text, log it and stop observing
        if (tokens > 0) {
            updateStorage('prompt', tokens);
            userMessageStates.set(node, true); // Mark as done
            return true;
        }
        return false;
    };

    // 1. Try immediately
    if (checkAndLog()) return;

    // 2. If no text yet, observe for a short period (user messages load quickly)
    // We mark it as 'observing'
    userMessageStates.set(node, 'observing');

    const userObserver = new MutationObserver((mutations, obs) => {
        if (checkAndLog()) {
            obs.disconnect();
        }
    });

    userObserver.observe(node, {
        childList: true,
        characterData: true,
        subtree: true
    });

    // Safety timeout to stop observing if nothing happens (e.g. empty container)
    setTimeout(() => {
        userObserver.disconnect();
        if (userMessageStates.get(node) === 'observing') {
            userMessageStates.set(node, true); // Give up to free memory logic
        }
    }, 10000);
}

function monitorAIResponse(node) {
    if (aiStreamStates.has(node)) return; // Already monitoring

    // Initialize state
    aiStreamStates.set(node, 0);

    const updateLogic = () => {
        const text = node.innerText;
        const currentTokens = countTokens(text);
        const lastTokens = aiStreamStates.get(node) || 0;
        const delta = currentTokens - lastTokens;

        if (delta > 0) {
            updateStorage('response', delta);
            aiStreamStates.set(node, currentTokens);
        }
    };

    // Run initial check
    updateLogic();

    // Observe active changes (streaming)
    const streamObserver = new MutationObserver((mutations) => {
        updateLogic();
    });

    streamObserver.observe(node, {
        childList: true,
        characterData: true,
        subtree: true
    });

    // Optional: could disconnect after long silence, but keeping it active handles corrections/updates.
}

function handleNode(node) {
    if (!currentConfig) return;

    // 1. Check if node IS the user message or CONTAINS it
    if (node.matches && node.matches(currentConfig.user)) {
        monitorUserMessage(node);
    } else if (node.querySelector) {
        const userChild = node.querySelector(currentConfig.user);
        if (userChild) monitorUserMessage(userChild);
    }

    // 2. Check if node IS the AI message or CONTAINS it
    if (node.matches && node.matches(currentConfig.ai)) {
        monitorAIResponse(node);
    } else if (node.querySelector) {
        const aiChild = node.querySelector(currentConfig.ai);
        if (aiChild) monitorAIResponse(aiChild);
    }
}

const mainObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) { // Element node
                    handleNode(node);
                }
            });
        }
    }
});

// Start observing
const chatBody = document.querySelector('body');
if (chatBody && currentConfig) {
    // We don't scan existing nodes to avoid double-counting on reload 
    // unless we had a way to persist "processed" state across reloads.
    // For now, we only track *new* interactions in the session.
    mainObserver.observe(chatBody, { childList: true, subtree: true });
    console.log('[EcoPrompt] Tracking started for ' + hostname);
} else {
    console.log('[EcoPrompt] Not active or config missing for this site.');
}