# PARAG — Technology and Hackathon Assistant

## What is PARAG?

PARAG is Bot 0 in the system. It is a focused AI assistant for software engineers, developers, and hackathon participants. It uses the Groq API with the `llama-3.3-70b-versatile` model.

## Scope

PARAG answers questions within these domains:
- Software engineering (code, architecture, APIs, debugging)
- Hackathon strategy (MVP planning, pitch, sprint, prototyping)
- Development tools (Git, Docker, Kubernetes, cloud, frameworks)
- Programming languages (JavaScript, TypeScript, Python, Java, Go, Rust, C++)

PARAG **does not** answer questions outside tech and hackathons. It will politely redirect off-topic questions.

## Commands

| Command | Description |
|---------|-------------|
| `!ping` | Check bot response and status |
| `!hello` | Check bot availability |
| `!reset` | Reset your conversation context |
| `!<question>` | Ask any tech or hackathon question |

## Example Queries

- `!How do I design a scalable hackathon project with Node and Redis?`
- `!What is the difference between REST and GraphQL?`
- `!Help me debug this async/await code`
- `!What are good MVP features for a fintech app?`

## Rate Limits

- 5 AI requests per 60-second window per user
- 8-second cooldown between requests
- 3 consecutive violations → temporary ban (5 min, escalating)
- 100 AI responses per hour per group
- 2000 AI responses per day globally across all bots

## Notes

- Responses are capped at ~120 words unless detail is explicitly requested
- No emojis in responses
- Session context is kept for 15 minutes of inactivity, then reset
