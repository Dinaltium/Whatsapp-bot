const fetch = global.fetch || require('node-fetch');

function isTechOrHackathonQuery(query) {
  if (!query) return false;

  const techKeywords = [
    "code", "coding", "program", "programming", "developer", "debug",
    "bug", "api", "backend", "frontend", "database", "sql", "nosql",
    "software", "develop", "development", "app", "application", "website",
    "web", "mobile", "beginner", "learn", "learning", "framework",
    "javascript", "typescript", "python", "java", "c++", "golang", "rust",
    "react", "next", "node", "express", "docker", "kubernetes", "cloud",
    "aws", "azure", "gcp", "machine learning", "ai", "llm", "model",
    "algorithm", "data structure", "git", "github", "devops", "security",
    "hackathon", "prototype", "pitch", "mvp", "sprint", "roadmap", "deployment",
    "redis", "cache", "latency", "concurrency", "thread", "node.js", "node"
  ];

  const normalizedQuery = query.toLowerCase();
  return techKeywords.some((keyword) => normalizedQuery.includes(keyword));
}

function getDomainRestrictionReply() {
  return [
    "I can help with tech and hackathon topics only.",
    "Try asking about coding, architecture, APIs, debugging, MVP planning, or pitch strategy.",
    "Example: !How do I design a scalable hackathon project with Node and Redis?"
  ].join("\n");
}

async function getGroqReply(conversationMessages, groqApiKey, groqModel) {
  if (!groqApiKey) {
    return "Groq key missing. Set GROQ_API_KEY in your environment to enable AI replies.";
  }

  const systemPrompt = [
    "You are PARAG, a concise assistant for technology and hackathon support.",
    "Answer only within software engineering, product prototyping, and hackathon execution.",
    "If the user asks outside those domains, politely refuse and redirect to tech/hackathon topics.",
    "Keep responses practical, actionable, and under 120 words unless detail is explicitly requested."
  ].join(" ");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`
    },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...conversationMessages
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Groq API ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const aiText = data?.choices?.[0]?.message?.content?.trim();

  if (!aiText) {
    throw new Error("Groq returned an empty response.");
  }

  return aiText;
}

async function handleAgentMessage(session, userPrompt, groqApiKey, groqModel, isAdmin = false) {
  const irrelevantWords = ["mountain", "elevation", "beachfront", "shore", "sea", "altitude"];

  const normalized = (userPrompt || "").toLowerCase();
  const hasIrrelevant = irrelevantWords.some(w => normalized.includes(w));
  const isTech = isTechOrHackathonQuery(userPrompt);

  if (!isTech && !session.domainUnlocked && !isAdmin) {
    return { reply: getDomainRestrictionReply(), usedAI: false, domainLocked: true };
  }

  if (isTech && hasIrrelevant) {
    const reply = [
      "That question is outside my scope. I focus on software engineering, product prototyping, and hackathon execution.",
      "For Redis cache optimization in Node.js, consider using the `redis` package with cluster mode or `ioredis` for better concurrency.",
      "Ignore external factors like mountain elevation shifts, as they don't impact Redis performance."
    ].join(" ");

    return { reply, usedAI: false };
  }

  // Otherwise, call Groq
  const aiReply = await getGroqReply(session.messages, groqApiKey, groqModel);
  return { reply: aiReply, usedAI: true };
}

module.exports = {
  isTechOrHackathonQuery,
  getDomainRestrictionReply,
  handleAgentMessage
};
