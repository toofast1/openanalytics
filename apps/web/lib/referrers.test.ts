import { describe, expect, it } from "vitest"
import { foldAiReferrals } from "@/components/dashboard/ai-referrals-card"
import { foldReferrers } from "@/components/dashboard/top-sources-card"
import type { SourceRow } from "@/lib/api"
import { resolveAiUtm, resolveReferrer } from "./referrers"

describe("resolveReferrer and resolveAiUtm", () => {
  it("resolves AI assistant domains and their root hosts as kind: ai", () => {
    expect(resolveReferrer("chatgpt.com")).toEqual({
      name: "ChatGPT",
      domain: "chatgpt.com",
      kind: "ai",
    })
    expect(resolveReferrer("chat.openai.com")).toEqual({
      name: "ChatGPT",
      domain: "chatgpt.com",
      kind: "ai",
    })
    expect(resolveReferrer("openai.com")).toEqual({
      name: "ChatGPT",
      domain: "chatgpt.com",
      kind: "ai",
    })
    expect(resolveReferrer("deepseek.com")).toEqual({
      name: "DeepSeek",
      domain: "deepseek.com",
      kind: "ai",
    })
    expect(resolveReferrer("mistral.ai")).toEqual({
      name: "Le Chat",
      domain: "mistral.ai",
      kind: "ai",
    })
    expect(resolveReferrer("qwen.ai")).toEqual({
      name: "Qwen",
      domain: "qwen.ai",
      kind: "ai",
    })
    expect(resolveReferrer("anthropic.com")).toEqual({
      name: "Claude",
      domain: "claude.ai",
      kind: "ai",
    })
  })

  it("resolves dotted and bare AI utm_source tags alike", () => {
    expect(resolveAiUtm("chatgpt.com", "")?.name).toBe("ChatGPT")
    expect(resolveAiUtm("Claude AI", "claude.ai")?.name).toBe("Claude")
    expect(resolveAiUtm("deepseek.com", "")?.name).toBe("DeepSeek")
    expect(resolveAiUtm("mistral.ai", "")?.name).toBe("Le Chat")
    expect(resolveAiUtm("newsletter", "email")).toBeNull()
  })

  it("folds AI utm-only visits into the assistant on both Referrers and AI referrals cards", () => {
    const items: SourceRow[] = [
      {
        referrer_domain: "chatgpt.com",
        utm_source: "chatgpt.com",
        utm_medium: "",
        utm_campaign: "",
        views: 10,
        visitors: 5,
      },
      {
        referrer_domain: "",
        utm_source: "chatgpt.com",
        utm_medium: "",
        utm_campaign: "",
        views: 4,
        visitors: 2,
      },
      {
        referrer_domain: "",
        utm_source: "",
        utm_medium: "",
        utm_campaign: "",
        views: 8,
        visitors: 6,
      },
    ]

    const aiRows = foldAiReferrals(items)
    expect(aiRows).toEqual([
      {
        label: "ChatGPT",
        domain: "chatgpt.com",
        direct: false,
        views: 14,
        visitors: 7,
        raw: ["chatgpt.com"],
      },
    ])

    const referrerRows = foldReferrers(items)
    expect(referrerRows).toEqual([
      {
        label: "ChatGPT",
        domain: "chatgpt.com",
        direct: false,
        views: 14,
        visitors: 7,
        raw: ["chatgpt.com"],
      },
      {
        label: "Direct / none",
        domain: null,
        direct: true,
        views: 8,
        visitors: 6,
        raw: [""],
      },
    ])
  })
})

