// OAuth handler for different providers
// This communicates with the main process to handle OAuth flows

async function loginOAuth(providerName, authMethod) {
  console.log('[OAuth] loginOAuth called:', providerName, authMethod);
  const provider = (window.providers || {})[providerName];

  if (!provider) {
    console.error('[OAuth] Provider not found:', providerName, 'available:', Object.keys(window.providers || {}));
    alert('Provider not found: ' + providerName);
    return;
  }

  try {
    console.log('[OAuth] Starting OAuth for provider:', providerName);
    // Show loading state
    const card = document.getElementById(`provider-${providerName}`);
    const statusEl = card?.querySelector('.oauth-status');
    if (statusEl) {
      statusEl.textContent = 'Starting authentication...';
    }

    // Get apiKey or token from the input field if it exists
    const apiKeyInput = document.getElementById(`apiKey-${providerName}`);
    const apiKey = apiKeyInput ? apiKeyInput.value : null;
    const token = apiKeyInput ? apiKeyInput.value : null;

    // Call main process to start OAuth
    const result = await window.verso.startOAuth({
      providerName,
      authMethod,
      providerType: provider._providerType,
      apiKey,
      token
    });

    if (result.success) {
      // Update provider with OAuth credentials
      provider.oauthToken = result.credentials || result.token;
      provider.oauthRefreshToken = result.refreshToken;

      await saveProviders();
      renderProviders();

      alert('Authentication successful!');
    } else {
      throw new Error(result.error || 'Authentication failed');
    }
  } catch (err) {
    console.error('OAuth error:', err);
    alert(`Authentication failed: ${err.message}`);
  }
}

// Export for use in providers.js
window.loginOAuth = loginOAuth;
