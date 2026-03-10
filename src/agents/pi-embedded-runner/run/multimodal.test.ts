import { describe, expect, it } from "vitest";
import {
  resolveMultimodalStrategy,
  modelSupportsNativeImages,
  modelSupportsVideo,
  type MultimodalStrategy,
} from "./multimodal.js";

describe("resolveMultimodalStrategy", () => {
  it("text-only model: all modalities skipped", () => {
    const strategy = resolveMultimodalStrategy({ input: ["text"] });
    expect(strategy).toEqual<MultimodalStrategy>({
      image: "skip",
      video: "skip",
    });
  });

  it("text+image model: image native, video skipped", () => {
    const strategy = resolveMultimodalStrategy({ input: ["text", "image"] });
    expect(strategy.image).toBe("native");
    expect(strategy.video).toBe("skip");
  });

  it("text+image+video model: image native, video via media-understanding", () => {
    const strategy = resolveMultimodalStrategy({ input: ["text", "image", "video"] });
    expect(strategy.image).toBe("native");
    expect(strategy.video).toBe("media-understanding");
  });

  it("text+video model (no image): video via media-understanding, image skipped", () => {
    const strategy = resolveMultimodalStrategy({ input: ["text", "video"] });
    expect(strategy.image).toBe("skip");
    expect(strategy.video).toBe("media-understanding");
  });

  it("undefined input defaults to text-only", () => {
    const strategy = resolveMultimodalStrategy({});
    expect(strategy.image).toBe("skip");
    expect(strategy.video).toBe("skip");
  });

  it("empty input array defaults to text-only", () => {
    const strategy = resolveMultimodalStrategy({ input: [] });
    expect(strategy.image).toBe("skip");
    expect(strategy.video).toBe("skip");
  });
});

describe("modelSupportsNativeImages", () => {
  it("returns true when model has image input", () => {
    expect(modelSupportsNativeImages({ input: ["text", "image"] })).toBe(true);
  });

  it("returns false when model has no image input", () => {
    expect(modelSupportsNativeImages({ input: ["text"] })).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(modelSupportsNativeImages({})).toBe(false);
  });
});

describe("modelSupportsVideo", () => {
  it("returns true when model has video input", () => {
    expect(modelSupportsVideo({ input: ["text", "image", "video"] })).toBe(true);
  });

  it("returns false when model has no video input", () => {
    expect(modelSupportsVideo({ input: ["text", "image"] })).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(modelSupportsVideo({})).toBe(false);
  });
});

describe("multimodal chain invariants", () => {
  it("audio is never a model input type — handled by MediaUnderstanding", () => {
    // Even if someone passes "audio" in input, it's ignored by the strategy
    // because resolveMultimodalStrategy only checks "image" and "video"
    const strategy = resolveMultimodalStrategy({ input: ["text", "audio" as string] });
    expect(strategy.image).toBe("skip");
    expect(strategy.video).toBe("skip");
    // "audio" has no effect on the strategy — it's a MediaUnderstanding capability
  });

  it("image is the only native modality (pi-ai SDK constraint)", () => {
    // Video always goes through media-understanding, never native
    const strategy = resolveMultimodalStrategy({ input: ["text", "image", "video"] });
    expect(strategy.image).toBe("native");
    expect(strategy.video).toBe("media-understanding");
  });

  it("strategy is deterministic for same input", () => {
    const input = { input: ["text", "image", "video"] };
    const a = resolveMultimodalStrategy(input);
    const b = resolveMultimodalStrategy(input);
    expect(a).toEqual(b);
  });
});
