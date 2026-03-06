// src/app/onboarding/index.tsx - Main onboarding flow

import React, { useState } from "react";
import { ChannelSetup } from "./channel-setup";
import { CompletionScreen } from "./completion";
import { ProviderSetup, type ProviderConfig } from "./provider-setup";
import { WelcomeScreen } from "./welcome";

type OnboardingStep = "welcome" | "provider" | "channels" | "complete";

interface OnboardingFlowProps {
  onComplete: (config: OnboardingConfig) => void;
}

export interface OnboardingConfig {
  provider: ProviderConfig;
  channels: {
    telegram?: { enabled: boolean; botToken?: string };
    wecom?: { enabled: boolean };
  };
}

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ onComplete }) => {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [config, setConfig] = useState<Partial<OnboardingConfig>>({});

  const handleProviderNext = (providerConfig: ProviderConfig) => {
    setConfig({ ...config, provider: providerConfig });
    setStep("channels");
  };

  const handleChannelsNext = (channels: OnboardingConfig["channels"]) => {
    const finalConfig: OnboardingConfig = {
      provider: config.provider!,
      channels,
    };
    setConfig(finalConfig);
    setStep("complete");
  };

  const handleComplete = () => {
    onComplete(config as OnboardingConfig);
  };

  return (
    <div className="onboarding-container">
      <div className="progress-steps">
        <div className="step">
          <div className={`step-circle ${step === "welcome" ? "active" : "completed"}`}>1</div>
        </div>
        <div className="step-line" />
        <div className="step">
          <div
            className={`step-circle ${step === "provider" ? "active" : step === "channels" || step === "complete" ? "completed" : ""}`}
          >
            2
          </div>
        </div>
        <div className="step-line" />
        <div className="step">
          <div
            className={`step-circle ${step === "channels" ? "active" : step === "complete" ? "completed" : ""}`}
          >
            3
          </div>
        </div>
        <div className="step-line" />
        <div className="step">
          <div className={`step-circle ${step === "complete" ? "active" : ""}`}>4</div>
        </div>
      </div>

      <div className="onboarding-content">
        {step === "welcome" && <WelcomeScreen onNext={() => setStep("provider")} />}

        {step === "provider" && (
          <ProviderSetup onNext={handleProviderNext} onBack={() => setStep("welcome")} />
        )}

        {step === "channels" && (
          <ChannelSetup onNext={handleChannelsNext} onBack={() => setStep("provider")} />
        )}

        {step === "complete" && <CompletionScreen onComplete={handleComplete} />}
      </div>
    </div>
  );
};
