// src/app/onboarding/welcome.tsx - Welcome screen with Verso logo

import React from "react";

interface WelcomeProps {
  onNext: () => void;
}

export const WelcomeScreen: React.FC<WelcomeProps> = ({ onNext }) => {
  return (
    <div className="onboarding-screen welcome">
      <div className="logo-container">
        <img src="/Verso.png" alt="Verso" className="app-logo" />
        <h1>Welcome to Verso</h1>
        <p className="tagline">Your AI-powered personal assistant</p>
      </div>

      <div className="welcome-content">
        <div className="feature-list">
          <div className="feature-item">
            <span className="icon">🤖</span>
            <h3>Multi-Agent Orchestration</h3>
            <p>Coordinate multiple AI agents to handle complex tasks</p>
          </div>

          <div className="feature-item">
            <span className="icon">🔌</span>
            <h3>Flexible Providers</h3>
            <p>Choose from Anthropic, OpenAI, or custom API endpoints</p>
          </div>

          <div className="feature-item">
            <span className="icon">💬</span>
            <h3>Multi-Channel Support</h3>
            <p>Connect via Telegram, WeChat Work, and more</p>
          </div>
        </div>
      </div>

      <button className="btn-primary" onClick={onNext}>
        Get Started
      </button>
    </div>
  );
};
