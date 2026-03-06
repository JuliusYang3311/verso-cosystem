// src/app/onboarding/completion.tsx - Completion screen

import React from "react";

interface CompletionScreenProps {
  onComplete: () => void;
}

export const CompletionScreen: React.FC<CompletionScreenProps> = ({ onComplete }) => {
  return (
    <div className="onboarding-screen completion">
      <div className="completion-content">
        <div className="success-icon">✓</div>
        <h2>All Set!</h2>
        <p className="completion-message">
          Verso is ready to assist you. You can change these settings anytime in the Settings panel.
        </p>

        <div className="next-steps">
          <h3>What's Next?</h3>
          <ul>
            <li>Start a conversation with Verso</li>
            <li>Try multi-agent orchestration for complex tasks</li>
            <li>Configure additional channels in Settings</li>
          </ul>
        </div>
      </div>

      <button className="btn-primary btn-large" onClick={onComplete}>
        Start Using Verso
      </button>
    </div>
  );
};
