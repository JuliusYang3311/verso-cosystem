// OAuth handler for different providers
// This communicates with the main process to handle OAuth flows

async function loginOAuth(providerName, authMethod) {
  const provider = providers[providerName];

  if (!provider) {
    alert('Provider not found');
    return;
  }

  try {
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
